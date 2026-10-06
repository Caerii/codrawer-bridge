//! A minimal inotify(7) binding: the bridge sleeps until a file it cares about changes instead of
//! waking on a timer to look (Go: `inotify_linux.go`).
//!
//! # Why
//!
//! Every periodic wakeup costs battery on the Paper Pro: it pulls the SoC out of deep idle, and
//! the page watcher's former 1 s poll also listed xochitl's whole data directory (a stat per
//! entry, hundreds of entries) to find the newest `.content`. inotify lets the kernel tell the
//! page thread when xochitl writes, so an idle tablet costs the bridge nothing.
//!
//! # Shape
//!
//! [`Inotify`] owns one non-blocking inotify descriptor. [`Inotify::add`] watches a directory
//! and returns its watch descriptor; [`Inotify::wait`] blocks in `poll(2)` until events arrive
//! or a deadline passes, then reads every queued event. Only the fields the bridge needs are
//! decoded: the watch, the mask and the entry name.
//!
//! On anything but Linux, [`Inotify::new`] fails with `Unsupported`, which callers treat like an
//! inotify that could not start: they fall back to polling.

use std::io;
use std::path::Path;
use std::time::Instant;

/// One decoded `struct inotify_event`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// The watch descriptor the event belongs to (-1 for a queue overflow).
    pub wd: i32,
    /// `IN_*` bits.
    pub mask: u32,
    /// The entry's name inside the watched directory ("" for events on the directory itself).
    pub name: String,
}

// The `IN_*` values from <sys/inotify.h> (identical on every Linux architecture).
pub const IN_ATTRIB: u32 = 0x0000_0004;
pub const IN_CLOSE_WRITE: u32 = 0x0000_0008;
pub const IN_MOVED_FROM: u32 = 0x0000_0040;
pub const IN_MOVED_TO: u32 = 0x0000_0080;
pub const IN_CREATE: u32 = 0x0000_0100;
pub const IN_DELETE: u32 = 0x0000_0200;
pub const IN_DELETE_SELF: u32 = 0x0000_0400;
pub const IN_MOVE_SELF: u32 = 0x0000_0800;
pub const IN_Q_OVERFLOW: u32 = 0x0000_4000;
pub const IN_IGNORED: u32 = 0x0000_8000;
pub const IN_ONLYDIR: u32 = 0x0100_0000;
pub const IN_ISDIR: u32 = 0x4000_0000;

/// What a writer does to a directory entry that matters to a reader: a write finished, an entry
/// was renamed in or out (atomic saves), created or deleted.
pub const DIR_CHANGES: u32 = IN_CLOSE_WRITE | IN_MOVED_TO | IN_MOVED_FROM | IN_CREATE | IN_DELETE;

/// Decodes a buffer of `struct inotify_event` records (each: wd i32, mask u32, cookie u32,
/// len u32, then `len` bytes of NUL-padded name), in native byte order.
pub fn decode(buf: &[u8], out: &mut Vec<Event>) {
    let mut i = 0;
    while i + 16 <= buf.len() {
        let word = |k: usize| u32::from_ne_bytes(buf[i + k..i + k + 4].try_into().expect("4 bytes"));
        let (wd, mask, len) = (word(0) as i32, word(4), word(12) as usize);
        let end = (i + 16 + len).min(buf.len());
        let raw = &buf[i + 16..end];
        let name = &raw[..raw.iter().position(|&b| b == 0).unwrap_or(raw.len())];
        out.push(Event { wd, mask, name: String::from_utf8_lossy(name).into_owned() });
        i = end;
    }
}

#[cfg(target_os = "linux")]
mod sys {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    /// One inotify instance. Dropping it closes the descriptor and with it every watch.
    pub struct Inotify {
        fd: OwnedFd,
    }

    impl Inotify {
        pub fn new() -> io::Result<Self> {
            let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Inotify { fd: unsafe { OwnedFd::from_raw_fd(fd) } })
        }

        /// Watches `path` for `mask`; returns the watch descriptor. Adding a path twice returns
        /// the same descriptor (the kernel replaces the mask).
        pub fn add(&self, path: &Path, mask: u32) -> io::Result<i32> {
            let c = CString::new(path.as_os_str().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
            let wd = unsafe { libc::inotify_add_watch(self.fd.as_raw_fd(), c.as_ptr(), mask) };
            if wd < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(wd)
        }

        /// Stops a watch (errors ignored: the watch may already be gone with its directory).
        pub fn remove(&self, wd: i32) {
            unsafe { libc::inotify_rm_watch(self.fd.as_raw_fd(), wd) };
        }

        /// Blocks until events are queued or `deadline` passes (`None`: no deadline), then returns
        /// every queued event (empty on timeout).
        pub fn wait(&self, deadline: Option<Instant>) -> io::Result<Vec<Event>> {
            let timeout_ms = match deadline {
                None => -1,
                Some(d) => {
                    // round up, so a wait never returns just before its deadline and spins
                    let left = d.saturating_duration_since(Instant::now());
                    left.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32
                }
            };
            let mut pfd = libc::pollfd { fd: self.fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            let r = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
            if r < 0 {
                let e = io::Error::last_os_error();
                return if e.kind() == io::ErrorKind::Interrupted { Ok(Vec::new()) } else { Err(e) };
            }
            let mut out = Vec::new();
            if r == 0 {
                return Ok(out);
            }
            // Large enough for many events at once (each is 16 bytes + NAME_MAX + 1 at most).
            let mut buf = [0u8; 8192];
            loop {
                let n = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
                if n < 0 {
                    let e = io::Error::last_os_error();
                    match e.kind() {
                        io::ErrorKind::WouldBlock => return Ok(out),
                        io::ErrorKind::Interrupted => continue,
                        _ => return Err(e),
                    }
                }
                if n == 0 {
                    return Ok(out);
                }
                decode(&buf[..n as usize], &mut out);
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod sys {
    use super::*;

    /// No inotify off Linux: [`Inotify::new`] always fails, and callers poll instead.
    pub struct Inotify(());

    impl Inotify {
        pub fn new() -> io::Result<Self> {
            Err(io::Error::new(io::ErrorKind::Unsupported, "inotify needs Linux"))
        }
        pub fn add(&self, _path: &Path, _mask: u32) -> io::Result<i32> {
            Err(io::ErrorKind::Unsupported.into())
        }
        pub fn remove(&self, _wd: i32) {}
        pub fn wait(&self, _deadline: Option<Instant>) -> io::Result<Vec<Event>> {
            Err(io::ErrorKind::Unsupported.into())
        }
    }
}

pub use sys::Inotify;

#[cfg(test)]
mod tests {
    use super::*;

    fn record(wd: i32, mask: u32, name: &str, pad: usize) -> Vec<u8> {
        let len = name.len() + pad;
        let mut b = Vec::new();
        for w in [wd as u32, mask, 0, len as u32] {
            b.extend_from_slice(&w.to_ne_bytes());
        }
        b.extend_from_slice(name.as_bytes());
        b.extend(std::iter::repeat(0).take(pad));
        b
    }

    #[test]
    fn decodes_padded_records() {
        let mut buf = record(3, IN_MOVED_TO, "d.content", 7);
        buf.extend(record(-1, IN_Q_OVERFLOW, "", 0));
        buf.extend(record(4, IN_CLOSE_WRITE | IN_ISDIR, "x", 15));
        let mut out = Vec::new();
        decode(&buf, &mut out);
        assert_eq!(
            out,
            [
                Event { wd: 3, mask: IN_MOVED_TO, name: "d.content".into() },
                Event { wd: -1, mask: IN_Q_OVERFLOW, name: String::new() },
                Event { wd: 4, mask: IN_CLOSE_WRITE | IN_ISDIR, name: "x".into() },
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reports_a_write_and_times_out_when_quiet() {
        use std::time::Duration;
        let dir = std::env::temp_dir().join(format!("codrawer-inotify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ino = Inotify::new().unwrap();
        let wd = ino.add(&dir, DIR_CHANGES | IN_ONLYDIR).unwrap();

        let t = Instant::now();
        assert!(ino.wait(Some(t + Duration::from_millis(50))).unwrap().is_empty());
        assert!(t.elapsed() >= Duration::from_millis(50), "returned before the deadline");

        std::fs::write(dir.join("a.content"), b"{}").unwrap();
        let evs = ino.wait(Some(Instant::now() + Duration::from_secs(5))).unwrap();
        assert!(evs.iter().any(|e| e.wd == wd && e.name == "a.content" && e.mask & IN_CLOSE_WRITE != 0), "{evs:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
