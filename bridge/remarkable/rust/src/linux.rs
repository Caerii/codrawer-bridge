//! Linux-only device plumbing (linux_input.go, device_select.go, keyboard.go, uinput.go):
//! EVIOCGABS / EVIOCGRAB ioctls, probing /dev/input/event* for pen activity, the pen and keyboard
//! reader threads, and the uinput virtual keyboard the typer uses.
//!
//! Compiled for the Paper Pro (aarch64) but, unlike the Go version, not yet exercised on the
//! device: see the README.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::sync::mpsc::Receiver;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};

use crate::devices::find_keyboard_device;
use crate::input::*;
use crate::keymap::{text_to_keystrokes, KeyTranslator, OutKey, KEY_LEFTSHIFT, VIRTUAL_KEYBOARD_NAME};

// ── ioctl encoding (Linux _IOC) ────────────────────────────────────────────

const IOC_WRITE: u32 = 1;
const IOC_READ: u32 = 2;

const fn ioc(dir: u32, typ: u32, nr: u32, size: u32) -> u32 {
    (dir << 30) | (size << 16) | (typ << 8) | nr
}

#[repr(C)]
#[derive(Default)]
struct AbsInfo {
    value: i32,
    min: i32,
    max: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

/// EVIOCGABS(abs) = _IOR('E', 0x40 + abs, struct input_absinfo)
const fn eviocgabs(abs: u16) -> u32 {
    ioc(IOC_READ, b'E' as u32, 0x40 + abs as u32, std::mem::size_of::<AbsInfo>() as u32)
}

/// EVIOCGRAB = _IOW('E', 0x90, int)
const EVIOCGRAB: u32 = ioc(IOC_WRITE, b'E' as u32, 0x90, 4);

// uinput.h
const UI_SET_EVBIT: u32 = 0x4004_5564; // _IOW('U', 100, int)
const UI_SET_KEYBIT: u32 = 0x4004_5565; // _IOW('U', 101, int)
const UI_DEV_CREATE: u32 = 0x0000_5501; // _IO('U', 1)
const UI_DEV_SETUP: u32 = 0x405c_5503; // _IOW('U', 3, struct uinput_setup) — 92 bytes
const BUS_VIRTUAL: u16 = 0x06;

fn ioctl_ptr<T>(fd: i32, req: u32, arg: *mut T) -> io::Result<()> {
    // The request parameter is c_ulong on glibc and c_int on musl; `as _` fits either.
    let r = unsafe { libc::ioctl(fd, req as _, arg) };
    if r < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn ioctl_val(fd: i32, req: u32, val: libc::c_ulong) -> io::Result<()> {
    let r = unsafe { libc::ioctl(fd, req as _, val) };
    if r < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn get_abs_info(fd: i32, code: u16) -> io::Result<AbsInfo> {
    let mut info = AbsInfo::default();
    ioctl_ptr(fd, eviocgabs(code), &mut info)?;
    Ok(info)
}

pub fn get_ranges(fd: i32) -> AbsRanges {
    let mut r = AbsRanges::default();
    if let Ok(x) = get_abs_info(fd, ABS_X) {
        (r.x_min, r.x_max) = (x.min, x.max);
    }
    if let Ok(y) = get_abs_info(fd, ABS_Y) {
        (r.y_min, r.y_max) = (y.min, y.max);
    }
    if let Ok(p) = get_abs_info(fd, ABS_PRESSURE) {
        (r.p_min, r.p_max) = (p.min, p.max);
    }
    r
}

pub fn try_grab(fd: i32) {
    let mut one: libc::c_int = 1;
    let _ = ioctl_ptr(fd, EVIOCGRAB, &mut one);
}

// ── device probing ─────────────────────────────────────────────────────────

#[derive(Debug, Default)]
struct DevProbe {
    path: String,
    abs_x: i64,
    abs_y: i64,
    abs_p: i64,
    abs_d: i64,
    btn_touch: i64,
    btn_pen: i64,
    btn_rubber: i64,
    any: i64,
}

impl DevProbe {
    /// Prefer X/Y/pressure/distance + tool keys. Any activity beats none.
    fn score(&self) -> i64 {
        self.any + 5 * self.abs_x + 5 * self.abs_y + 8 * self.abs_p + 8 * self.abs_d + 8 * self.btn_touch + 6 * self.btn_pen + 6 * self.btn_rubber
    }
}

fn probe_device(path: &str, dur: Duration) -> io::Result<DevProbe> {
    let mut out = DevProbe { path: path.to_string(), ..Default::default() };
    let mut f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path)?;
    let fd = f.as_raw_fd();
    let mut parser = InputParser::new();
    let deadline = Instant::now() + dur;
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        unsafe { libc::poll(&mut pfd, 1, 50) };
        if pfd.revents & libc::POLLIN == 0 {
            continue;
        }
        let n = match f.read(&mut buf) {
            Ok(n) if n > 0 => n,
            _ => continue,
        };
        parser.feed(&buf[..n], |e| {
            out.any += 1;
            match (e.etype, e.code) {
                (EV_ABS, ABS_X) => out.abs_x += 1,
                (EV_ABS, ABS_Y) => out.abs_y += 1,
                (EV_ABS, ABS_PRESSURE) => out.abs_p += 1,
                (EV_ABS, ABS_DISTANCE) => out.abs_d += 1,
                (EV_KEY, BTN_TOUCH) => out.btn_touch += 1,
                (EV_KEY, BTN_TOOL_PEN) => out.btn_pen += 1,
                (EV_KEY, BTN_TOOL_RUBBER) => out.btn_rubber += 1,
                _ => {}
            }
        });
    }
    Ok(out)
}

/// `/dev/input/event*`, sorted as strings (like Go's filepath.Glob + sort.Strings).
fn event_nodes() -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir("/dev/input")
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| n.starts_with("event"))
                .map(|n| format!("/dev/input/{n}"))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// An explicit path wins; otherwise probe each event node for `probe` and pick the busiest
/// pen-like one (draw during the probe). On the Paper Pro this picks the power key unless you
/// draw: pass -input /dev/input/event2.
pub fn auto_detect_active_device(explicit: &str, debug: bool, probe: Duration) -> Result<String, String> {
    if !explicit.is_empty() {
        return Ok(explicit.to_string());
    }
    let nodes = event_nodes();
    if nodes.is_empty() {
        return Err("no /dev/input/event* devices found".into());
    }
    let mut best_score = -1;
    let mut best = DevProbe { path: nodes[0].clone(), ..Default::default() };
    for p in &nodes {
        let Ok(pr) = probe_device(p, probe) else { continue };
        let s = pr.score();
        if debug {
            println!(
                "[bridge] probe {p} score={s} any={} x={} y={} p={} d={} touch={} pen={} rubber={}",
                pr.any, pr.abs_x, pr.abs_y, pr.abs_p, pr.abs_d, pr.btn_touch, pr.btn_pen, pr.btn_rubber
            );
        }
        if s > best_score {
            best_score = s;
            best = pr;
        }
    }
    if debug {
        println!("[bridge] selected {} score={}", best.path, best.score());
    }
    Ok(best.path)
}

// ── pen reader ─────────────────────────────────────────────────────────────

/// Reads the pen device into `ev_tx` for the life of the process, reopening it on error. The
/// first successful open reports the axis ranges on `ready`.
pub fn pen_reader_forever(path: &str, no_grab: bool, ev_tx: mpsc::Sender<RawEvent>, ready: oneshot::Sender<AbsRanges>) {
    let mut ready = Some(ready);
    let mut buf = [0u8; 4096];
    loop {
        let mut f = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                println!("[bridge] pen device open failed ({e}); retrying in 2s");
                sleep(Duration::from_secs(2));
                continue;
            }
        };
        let fd = f.as_raw_fd();
        if !no_grab {
            try_grab(fd);
        }
        if let Some(r) = ready.take() {
            let _ = r.send(get_ranges(fd));
        }
        let mut parser = InputParser::new();
        loop {
            let n = match f.read(&mut buf) {
                Ok(0) => {
                    println!("[bridge] pen device read failed (EOF); reopening in 2s");
                    break;
                }
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    println!("[bridge] pen device read failed ({e}); reopening in 2s");
                    break;
                }
            };
            // consumer stalled (no socket): drop rather than block the device
            parser.feed(&buf[..n], |e| {
                let _ = ev_tx.try_send(e);
            });
        }
        drop(f);
        sleep(Duration::from_secs(2));
    }
}

// ── keyboard reader ────────────────────────────────────────────────────────

/// Reads the keyboard and pushes key messages into `out`. Never returns; when the device is
/// missing or drops, it retries.
pub fn run_keyboard_forever(explicit: &str, grab: bool, debug: bool, out: mpsc::Sender<OutKey>) {
    loop {
        let path = match find_keyboard_device(explicit) {
            Ok(p) => p,
            Err(e) => {
                if debug {
                    println!("[keyboard] {e}; retrying in 5s");
                }
                sleep(Duration::from_secs(5));
                continue;
            }
        };
        println!("[keyboard] using input device: {path}");
        let err = read_keyboard_once(&path, grab, debug, &out);
        println!("[keyboard] device closed ({err}); reopening in 2s");
        sleep(Duration::from_secs(2));
    }
}

fn read_keyboard_once(path: &str, grab: bool, debug: bool, out: &mpsc::Sender<OutKey>) -> io::Error {
    let mut f = match File::open(path) {
        Ok(f) => f,
        Err(e) => return e,
    };
    if grab {
        try_grab(f.as_raw_fd());
    }
    let mut parser = InputParser::new();
    let mut tr = KeyTranslator::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match f.read(&mut buf) {
            Ok(0) => return io::ErrorKind::UnexpectedEof.into(),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return e,
        };
        parser.feed(&buf[..n], |e| {
            let Some(k) = tr.feed(e.etype, e.code, e.value) else { return };
            if debug {
                println!(
                    "[keyboard] key={:?} char={:?} code={} repeat={} shift={} ctrl={}",
                    k.key, k.char, k.code, k.repeat, k.mods.shift, k.mods.ctrl
                );
            }
            let _ = out.try_send(k); // nobody draining (disconnected): drop rather than block
        });
    }
}

// ── virtual keyboard (uinput) ──────────────────────────────────────────────

/// struct uinput_setup: input_id (4×u16), name[80], ff_effects_max u32 — 92 bytes.
#[repr(C)]
struct UinputSetup {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
    name: [u8; 80],
    ff_effects_max: u32,
}

const _: () = assert!(std::mem::size_of::<UinputSetup>() == 92);

/// A uinput keyboard that types text into whatever field the tablet has focused.
pub struct VirtualKeyboard {
    f: File,
}

impl VirtualKeyboard {
    pub fn open(name: &str) -> io::Result<Self> {
        let f = OpenOptions::new().write(true).custom_flags(libc::O_NONBLOCK).open("/dev/uinput")?;
        let fd = f.as_raw_fd();
        let ctx = |what: String| move |e: io::Error| io::Error::new(e.kind(), format!("{what}: {e}"));
        ioctl_val(fd, UI_SET_EVBIT, EV_KEY as _).map_err(ctx("UI_SET_EVBIT".into()))?;
        ioctl_val(fd, UI_SET_EVBIT, EV_SYN as _).map_err(ctx("UI_SET_EVBIT syn".into()))?;
        for code in 1..128 {
            // every ordinary keyboard key
            ioctl_val(fd, UI_SET_KEYBIT, code).map_err(ctx(format!("UI_SET_KEYBIT {code}")))?;
        }
        let mut setup = UinputSetup {
            bustype: BUS_VIRTUAL,
            vendor: 0x5349,  // "SI"
            product: 0x4742, // "GB"
            version: 1,
            name: [0; 80],
            ff_effects_max: 0,
        };
        let n = name.len().min(79);
        setup.name[..n].copy_from_slice(&name.as_bytes()[..n]);
        ioctl_ptr(fd, UI_DEV_SETUP, &mut setup).map_err(ctx("UI_DEV_SETUP".into()))?;
        ioctl_val(fd, UI_DEV_CREATE, 0).map_err(ctx("UI_DEV_CREATE".into()))?;
        // The kernel needs a moment to register the new input node before it delivers events.
        sleep(Duration::from_millis(300));
        Ok(VirtualKeyboard { f })
    }

    fn emit(&mut self, etype: u16, code: u16, value: i32) -> io::Result<()> {
        self.f.write_all(&encode_event24(etype, code, value))
    }

    fn press(&mut self, code: u16, shift: bool) -> io::Result<()> {
        if shift {
            self.emit(EV_KEY, KEY_LEFTSHIFT, 1)?;
        }
        self.emit(EV_KEY, code, 1)?;
        self.emit(EV_SYN, SYN_REPORT, 0)?;
        self.emit(EV_KEY, code, 0)?;
        if shift {
            self.emit(EV_KEY, KEY_LEFTSHIFT, 0)?;
        }
        self.emit(EV_SYN, SYN_REPORT, 0)
    }

    /// Types `s`, pacing keystrokes by `per_char` so the UI keeps up.
    pub fn type_text(&mut self, s: &str, per_char: Duration) -> io::Result<()> {
        for (code, shift) in text_to_keystrokes(s) {
            self.press(code, shift)?;
            sleep(per_char);
        }
        Ok(())
    }
}

/// Owns the virtual keyboard and types whatever arrives on `rx`.
pub fn typer_forever(rx: Receiver<String>, per_char: Duration, debug: bool) {
    loop {
        let mut kb = match VirtualKeyboard::open(VIRTUAL_KEYBOARD_NAME) {
            Ok(kb) => kb,
            Err(e) => {
                println!("[typer] virtual keyboard unavailable ({e}); retrying in 10s");
                sleep(Duration::from_secs(10));
                continue;
            }
        };
        println!("[typer] virtual keyboard ready");
        loop {
            let Ok(s) = rx.recv() else { return }; // the bridge is gone
            if debug {
                println!("[typer] {s:?}");
            }
            if let Err(e) = kb.type_text(&s, per_char) {
                println!("[typer] write failed ({e}); reopening");
                break;
            }
        }
        drop(kb);
        sleep(Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ioctl_numbers_match_the_kernel_headers() {
        assert_eq!(eviocgabs(ABS_X), 0x8018_4540);
        assert_eq!(EVIOCGRAB, 0x4004_4590);
        assert_eq!(ioc(IOC_WRITE, b'U' as u32, 3, 92), UI_DEV_SETUP);
        assert_eq!(ioc(IOC_WRITE, b'U' as u32, 100, 4), UI_SET_EVBIT);
    }
}
