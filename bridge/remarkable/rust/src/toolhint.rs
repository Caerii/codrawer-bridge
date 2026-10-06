//! Which tool xochitl's toolbar has selected for the pen tip; a port of the Go package
//! `bridge/remarkable/native/toolhint`.
//!
//! # The problem
//!
//! The bridge reads the pen through evdev ([`crate::pen`]). That tells the Marker's eraser end
//! apart (BTN_TOOL_RUBBER, streamed as brush "eraser"), but not the toolbar. When the user picks
//! the toolbar's Eraser and erases with the tip, xochitl cuts ink while the bridge streamed the
//! stroke as more ink, so every viewer drew over what the tablet had just erased.
//!
//! xochitl knows the tool: its pen handler's `lineTool` property. The codrawer-layer XOVI
//! extension (bridge/remarkable/xovi/codrawer-layer, "Following the tool") runs inside xochitl,
//! follows that property's change signal and writes one line, `<tool> <thickness>`, to
//! /run/codrawer/tool by rename when it changes, and touches the file (utime) every 2 s as a
//! heartbeat. (Until 2026-10-06 it polled every 100 ms and rewrote the line every second;
//! either way a re-read follows any change of mtime or size.) The tool word is one of eraser, erase_area, clear_page, select, highlighter, shader,
//! zoom, pen, or none when no document is open. The device test that grounds it is in
//! `docs/investigations/native-erase.md` §6.
//!
//! # Invariants
//!
//! - The file is optional. Without the extension (stock xochitl, after a reboot, a hung xochitl)
//!   the file is absent or stops being refreshed, and [`File::tool`] returns "": the bridge then
//!   behaves exactly as before.
//! - A line is trusted only while the file's mtime is within `max_age` (3 s, three missed
//!   heartbeats) of the clock, in either direction.
//! - [`File::tool`] is cheap enough to call at every pen-down and hover sample: at most one stat
//!   per `every` (100 ms), and a read only when the mtime or size changed.
//!
//! A [`File`] belongs to the pen machine's task; it is not shared.

use std::time::{Duration, SystemTime};

/// Where the codrawer-layer extension writes the tool (tmpfs: gone at reboot).
pub const DEFAULT_PATH: &str = "/run/codrawer/tool";

/// Follows the tool file at `path`.
pub struct File {
    pub path: String,
    /// Trust the line only while the file's mtime is this close to the clock (3 s).
    pub max_age: Duration,
    /// Stat the file at most this often (100 ms).
    pub every: Duration,
    /// The wall clock, compared with the file's mtime (tests replace it).
    pub now: Box<dyn FnMut() -> SystemTime + Send>,

    /// When the file was last stat'ed; `None` before the first call.
    checked: Option<SystemTime>,
    /// The mtime and size of the line in `tool`; `None` while there is no file.
    seen: Option<(SystemTime, u64)>,
    tool: String,
}

impl File {
    /// A follower of `path` with the Go defaults: 3 s staleness, one stat per 100 ms.
    pub fn new(path: impl Into<String>) -> Self {
        File {
            path: path.into(),
            max_age: Duration::from_secs(3),
            every: Duration::from_millis(100),
            now: Box::new(SystemTime::now),
            checked: None,
            seen: None,
            tool: String::new(),
        }
    }

    /// The selected tool's word ("eraser", "pen", …), or "" when it is unknown: no file, a stale
    /// file, or "none"/"unknown" in it.
    pub fn tool(&mut self) -> &str {
        let now = (self.now)();
        // A clock that stepped back counts as due (Go's monotonic reading cannot step back).
        let due = match self.checked {
            None => true,
            Some(t) => now.duration_since(t).map_or(true, |d| d >= self.every),
        };
        if due {
            self.checked = Some(now);
            self.refresh();
        }
        let fresh = match self.seen {
            None => false,
            // |now - mtime| <= max_age, whichever side of the clock the mtime is on
            Some((mtime, _)) => match now.duration_since(mtime) {
                Ok(age) => age <= self.max_age,
                Err(ahead) => ahead.duration() <= self.max_age,
            },
        };
        if self.tool.is_empty() || !fresh {
            return "";
        }
        &self.tool
    }

    /// Re-reads the file when its mtime or size changed, and forgets it when it is gone.
    fn refresh(&mut self) {
        let st = match std::fs::metadata(&self.path) {
            Ok(st) => st,
            Err(_) => {
                (self.tool, self.seen) = (String::new(), None);
                return;
            }
        };
        let now_seen = (st.modified().unwrap_or(SystemTime::UNIX_EPOCH), st.len());
        if self.seen == Some(now_seen) {
            return;
        }
        self.seen = Some(now_seen);
        self.tool = match std::fs::read_to_string(&self.path) {
            Ok(s) => parse(&s).to_string(),
            Err(_) => String::new(),
        };
    }
}

/// The tool word of one line of the file: its first field, lower case, or "" for an empty line,
/// "none" or "unknown".
pub fn parse(line: &str) -> String {
    let w = match line.split_whitespace().next() {
        Some(w) => w.to_lowercase(),
        None => return String::new(),
    };
    if w == "none" || w == "unknown" {
        return String::new();
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::UNIX_EPOCH;

    /// A fresh path in a per-test directory (the file itself is not created).
    fn temp_path() -> String {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("codrawer-toolhint-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("tool").to_string_lossy().into_owned()
    }

    fn write(path: &str, line: &str, mtime: SystemTime) {
        std::fs::write(path, line).unwrap();
        std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(mtime).unwrap();
    }

    /// A File at `path` whose clock is the returned cell.
    fn follower(path: &str, start: SystemTime) -> (File, Arc<Mutex<SystemTime>>) {
        let now = Arc::new(Mutex::new(start));
        let mut f = File::new(path);
        let n = now.clone();
        f.now = Box::new(move || *n.lock().unwrap());
        (f, now)
    }

    fn base() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_790_000_000)
    }

    #[test]
    fn parses_the_first_word() {
        for (input, want) in [("eraser 4\n", "eraser"), ("pen 1", "pen"), ("Erase_Area 1\n", "erase_area"), ("none\n", ""), ("unknown\n", ""), ("", ""), ("  \n", "")] {
            assert_eq!(parse(input), want, "parse({input:?})");
        }
    }

    #[test]
    fn fresh_file_is_read() {
        let p = temp_path();
        write(&p, "eraser 4\n", base() - Duration::from_secs(1));
        let (mut f, _) = follower(&p, base());
        assert_eq!(f.tool(), "eraser");
    }

    #[test]
    fn missing_or_stale_file_is_unknown() {
        let p = temp_path();
        let (mut f, now) = follower(&p, base());
        assert_eq!(f.tool(), "", "missing file");
        // a stock xochitl leaves the last line behind; it stops counting after max_age
        write(&p, "eraser 4\n", base() - Duration::from_secs(4));
        *now.lock().unwrap() += Duration::from_millis(200);
        assert_eq!(f.tool(), "", "stale file");
    }

    #[test]
    fn changes_are_seen_after_every() {
        let p = temp_path();
        write(&p, "pen 1\n", base());
        let (mut f, now) = follower(&p, base());
        assert_eq!(f.tool(), "pen");
        write(&p, "eraser 4\n", base() + Duration::from_millis(50));
        *now.lock().unwrap() += Duration::from_millis(50);
        assert_eq!(f.tool(), "pen", "within every: the cached value, no stat");
        *now.lock().unwrap() += Duration::from_millis(60);
        assert_eq!(f.tool(), "eraser", "after every");
        // the heartbeat keeps it alive; then the file goes away
        std::fs::remove_file(&p).unwrap();
        *now.lock().unwrap() += Duration::from_millis(200);
        assert_eq!(f.tool(), "", "removed");
    }

    // Beyond the Go tests.

    #[test]
    fn mtime_ahead_of_the_clock_counts_within_max_age() {
        let p = temp_path();
        write(&p, "eraser 4\n", base() + Duration::from_secs(2));
        let (mut f, now) = follower(&p, base());
        assert_eq!(f.tool(), "eraser");
        *now.lock().unwrap() -= Duration::from_secs(2); // clock stepped back: due, and 4 s ahead
        assert_eq!(f.tool(), "");
    }
}
