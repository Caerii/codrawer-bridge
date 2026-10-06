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
use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};

use crate::devices::find_keyboard_device;
use crate::input::*;
use crate::keymap::{KeyTranslator, OutKey, VIRTUAL_KEYBOARD_NAME};
use crate::typer::{self, Burst};

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

/// KEY_MAX 0x2ff → 96 bytes of key bits.
const KEY_BITS_LEN: usize = 96;

/// EVIOCGKEY(len) = _IOR('E', 0x18, len): the device's current key state.
const EVIOCGKEY: u32 = ioc(IOC_READ, b'E' as u32, 0x18, KEY_BITS_LEN as u32);

/// Reads the device's current key state: bit k of the result is key k.
fn get_key_bits(fd: i32) -> io::Result<[u8; KEY_BITS_LEN]> {
    let mut bits = [0u8; KEY_BITS_LEN];
    ioctl_ptr(fd, EVIOCGKEY, bits.as_mut_ptr())?;
    Ok(bits)
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
/// first successful open reports the axis ranges on `ready`. After a kernel SYN_DROPPED it
/// discards up to the next SYN_REPORT, then synthesizes the true device state (evdev's
/// documented recovery), so the machine never keeps a stale contact state.
pub fn pen_reader_forever(
    path: &str,
    no_grab: bool,
    dump_events: bool,
    ev_tx: mpsc::Sender<RawEvent>,
    ready: oneshot::Sender<AbsRanges>,
) {
    let mut ready = Some(ready);
    let mut buf = vec![0u8; 64 * EVENT_SIZE]; // reused: up to 64 events per read
    // The machine never blocks, so this only fills if it is wedged; dropping is the lesser evil
    // there, and the SYN_DROPPED-style resync repairs the state.
    let emit = |ev: RawEvent| {
        typer::gate().pen(ev.etype, ev.code, ev.value); // the typer waits while the pen is near
        let _ = ev_tx.try_send(ev);
    };
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
        let mut resync = false;
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
            parser.feed(&buf[..n], |ev| {
                if dump_events {
                    println!("[ev] type={} code={} value={} t={}", ev.etype, ev.code, ev.value, ev.time_ms);
                }
                if ev.etype == EV_SYN && ev.code == SYN_DROPPED {
                    // The kernel buffer overflowed: discard up to the next SYN_REPORT, then read
                    // the true state from the device.
                    println!("[bridge] kernel dropped pen events; resyncing");
                    resync = true;
                    return;
                }
                if resync {
                    if ev.etype == EV_SYN && ev.code == SYN_REPORT {
                        resync = false;
                        for s in device_state(fd, ev.time_ms) {
                            emit(s);
                        }
                    }
                    return;
                }
                emit(ev);
            });
        }
        drop(f);
        sleep(Duration::from_secs(2));
    }
}

/// Contact and position read from the device, as events ending in a SYN_REPORT, so the machine
/// sees one coherent, current sample.
fn device_state(fd: i32, ts_ms: i64) -> Vec<RawEvent> {
    let ev = |etype, code, value| RawEvent { etype, code, value, time_ms: ts_ms };
    let mut evs = Vec::with_capacity(8);
    if let Ok(keys) = get_key_bits(fd) {
        for k in [BTN_TOOL_PEN, BTN_TOOL_RUBBER, BTN_TOUCH] {
            evs.push(ev(EV_KEY, k, key_down(&keys, k) as i32));
        }
    }
    for a in [ABS_X, ABS_Y, ABS_PRESSURE, ABS_DISTANCE] {
        if let Ok(info) = get_abs_info(fd, a) {
            evs.push(ev(EV_ABS, a, info.value));
        }
    }
    evs.push(ev(EV_SYN, SYN_REPORT, 0));
    evs
}

fn key_down(bits: &[u8; KEY_BITS_LEN], k: u16) -> bool {
    bits[(k / 8) as usize] & (1 << (k % 8)) != 0
}

/// Takes a 3 s timed kernel wake lock, so the last stroke leaves the radio before autosleep
/// suspends the tablet. It expires by itself; errors (no such file, no permission) are ignored.
pub fn hold_awake() {
    let _ = OpenOptions::new()
        .write(true)
        .open("/sys/power/wake_lock")
        .and_then(|mut f| f.write_all(b"codrawer-pen 3000000000"));
}

// ── keyboard reader ────────────────────────────────────────────────────────

/// Waits for a keyboard to appear. Most of the time none is connected (the Paper Pro's
/// Bluetooth is dormant unless brought up), so this is the keyboard thread's idle state: it
/// sleeps until a node appears in /dev/input (inotify), with a [`KEYBOARD_RESCAN`] net, instead
/// of rescanning /proc every 5 s. Without inotify it rescans every 5 s, as before.
struct InputNodes {
    ino: Option<crate::inotify::Inotify>,
}

/// With inotify, the longest the keyboard thread sleeps before rescanning anyway.
pub const KEYBOARD_RESCAN: Duration = Duration::from_secs(60);

impl InputNodes {
    fn new() -> Self {
        use crate::inotify::{Inotify, IN_ATTRIB, IN_CREATE, IN_MOVED_TO, IN_ONLYDIR};
        let ino = Inotify::new().ok().filter(|i| i.add(std::path::Path::new("/dev/input"), IN_CREATE | IN_MOVED_TO | IN_ATTRIB | IN_ONLYDIR).is_ok());
        InputNodes { ino }
    }

    /// Sleeps until /dev/input changes (or the rescan net), or 5 s without inotify.
    fn wait(&mut self) {
        let Some(ino) = &self.ino else {
            sleep(Duration::from_secs(5));
            return;
        };
        if ino.wait(Some(Instant::now() + KEYBOARD_RESCAN)).is_err() {
            self.ino = None;
            sleep(Duration::from_secs(5));
        }
    }
}

/// Reads the keyboard and pushes key messages into `out`. Never returns; when the device is
/// missing it waits for one to appear ([`InputNodes`]), when it drops it reopens after 2 s.
pub fn run_keyboard_forever(explicit: &str, grab: bool, debug: bool, out: mpsc::Sender<OutKey>) {
    let mut nodes = InputNodes::new();
    loop {
        let path = match find_keyboard_device(explicit) {
            Ok(p) => p,
            Err(e) => {
                if debug {
                    println!("[keyboard] {e}; waiting for an input device");
                }
                nodes.wait();
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

    /// Writes one burst's events in a single `write()`, then pauses (see [`crate::typer`]).
    fn write_burst(&mut self, b: &Burst) -> io::Result<()> {
        let mut buf = Vec::with_capacity(b.events.len() * 24);
        for &(etype, code, value) in &b.events {
            buf.extend_from_slice(&encode_event24(etype, code, value));
        }
        self.f.write_all(&buf)?;
        sleep(b.pause);
        Ok(())
    }

}

/// Where the typer stands between writes: when it last pressed a key, and the gate's activity
/// count then, so it knows whether xochitl may have left text mode since ([`typer::prime`]).
struct Pace {
    last_key: Instant,
    activity: u64,
}

impl Pace {
    /// Waits until the pen and the hand are off the screen ([`typer::Gate`]), then re-enters text
    /// mode with End if there was pen or touch activity, or a pause, since the last key.
    fn ready(&mut self, kb: &mut VirtualKeyboard, debug: bool) -> io::Result<()> {
        let gate = typer::gate();
        let mut held = false;
        loop {
            let w = gate.wait();
            if w.is_zero() {
                break;
            }
            if !held && debug {
                println!("[typer] holding: the pen or a hand is on the screen");
            }
            held = true;
            sleep(w.min(Duration::from_millis(50)));
        }
        if gate.activity() != self.activity || self.last_key.elapsed() > Duration::from_millis(typer::PRIME_IDLE_MS as u64) {
            kb.write_burst(&typer::prime())?;
        }
        Ok(())
    }

    fn typed(&mut self) {
        self.last_key = Instant::now();
        self.activity = typer::gate().activity();
    }
}

/// Owns the virtual keyboard and types whatever arrives on `rx`, as `shared` says when each reply
/// starts (a `typer_config` takes effect from the next reply). Before every write it waits for
/// the gate and primes text mode when needed ([`crate::typer`], facts 2 and 3); characters the
/// keyboard table cannot type are reported on `notes` as a `typer_note`.
pub fn typer_forever(rx: Receiver<String>, shared: Arc<typer::Shared>, notes: mpsc::Sender<String>, debug: bool) {
    let mut pace = Pace { last_key: Instant::now() - Duration::from_secs(60), activity: u64::MAX };
    loop {
        let mut kb = match VirtualKeyboard::open(VIRTUAL_KEYBOARD_NAME) {
            Ok(kb) => kb,
            Err(e) => {
                println!("[typer] virtual keyboard unavailable ({e}); retrying in 10s");
                sleep(Duration::from_secs(10));
                continue;
            }
        };
        println!("[typer] virtual keyboard ready ({:?}, keymap {})", shared.now(), shared.keymap.name);
        'replies: loop {
            let Ok(s) = rx.recv() else { return }; // the bridge is gone
            let now = shared.now();
            if debug {
                println!("[typer] {s:?} ({now:?})");
            }
            let (bursts, dropped) = typer::plan(&s, &now, &shared.keymap);
            if !dropped.is_empty() {
                println!("[typer] left out {dropped:?}: the {} keyboard cannot type them", shared.keymap.name);
                let _ = notes.try_send(typer::note(&dropped, &shared.keymap));
            }
            for b in &bursts {
                if let Err(e) = pace.ready(&mut kb, debug).and_then(|_| kb.write_burst(b)) {
                    println!("[typer] write failed ({e}); reopening");
                    break 'replies;
                }
                pace.typed();
            }
        }
        drop(kb);
        sleep(Duration::from_secs(2));
    }
}

/// Follows the touchscreen for the typer's gate ([`typer::Gate::touch`]): read-only, never
/// grabbed, so xochitl sees every touch as before. `explicit` is a device path, "auto" (the
/// first device whose name says touch, the Paper Pro's "Elan touch input") or "off".
pub fn touch_gate_forever(explicit: &str) {
    if explicit.eq_ignore_ascii_case("off") {
        return;
    }
    loop {
        let path = if explicit.is_empty() || explicit.eq_ignore_ascii_case("auto") {
            crate::devices::list_proc_input_devices()
                .into_iter()
                .find(|d| !d.virtual_dev && d.name.to_ascii_lowercase().contains("touch"))
                .and_then(|d| d.handlers.into_iter().find(|h| h.starts_with("event")))
                .map(|h| format!("/dev/input/{h}"))
        } else {
            Some(explicit.to_string())
        };
        let Some(path) = path else {
            println!("[typer] no touchscreen found; the typer waits for the pen only (retrying in 60s)");
            sleep(Duration::from_secs(60));
            continue;
        };
        match File::open(&path) {
            Ok(mut f) => {
                println!("[typer] following touches on {path}");
                let mut buf = vec![0u8; 64 * EVENT_SIZE];
                let mut parser = InputParser::new();
                loop {
                    match f.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => parser.feed(&buf[..n], |ev| typer::gate().touch(ev.etype, ev.code, ev.value)),
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            }
            Err(e) => println!("[typer] touchscreen {path} unavailable ({e})"),
        }
        sleep(Duration::from_secs(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ioctl_numbers_match_the_kernel_headers() {
        assert_eq!(eviocgabs(ABS_X), 0x8018_4540);
        assert_eq!(EVIOCGRAB, 0x4004_4590);
        assert_eq!(EVIOCGKEY, 0x8060_4518);
    }

    #[test]
    fn key_bits_index_like_the_kernel() {
        let mut bits = [0u8; KEY_BITS_LEN];
        bits[(BTN_TOUCH / 8) as usize] = 1 << (BTN_TOUCH % 8);
        assert!(key_down(&bits, BTN_TOUCH));
        assert!(!key_down(&bits, BTN_TOOL_PEN));
        assert!(!key_down(&bits, BTN_TOOL_RUBBER));
        assert_eq!(ioc(IOC_WRITE, b'U' as u32, 3, 92), UI_DEV_SETUP);
        assert_eq!(ioc(IOC_WRITE, b'U' as u32, 100, 4), UI_SET_EVBIT);
    }
}
