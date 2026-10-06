//! The uinput typer: how a reply becomes writes to the virtual keyboard, how fast, with which
//! keys, and when (typer.go is the same design).
//!
//! The typer is the fallback way into xochitl's focused text box. The codrawer-layer extension
//! inserts text directly when it runs (agent_ink.rs); without it, the bridge types the reply
//! through a uinput keyboard (`linux::VirtualKeyboard`). Five facts shape this module
//! (docs/investigations/keyboard-and-text.md, § 2; keyboard-latency.md, "Typer"):
//!
//! 1. **xochitl translates keys itself**, with static Type Folio tables in its platform plugin
//!    (libepaper.so), one per keyboard language, not with xkb. Under "United States" no key
//!    produces ``[ ] { } ^ ` ~``, and the keys a PC layout uses for five of them are *dead keys*
//!    that also change the next character. So the typer's keymap is generated from xochitl's
//!    own tables (`scripts/dev/epaper_keymap.py --typer` → `native/epaper_keymaps.json`,
//!    embedded here), chosen by the tablet's keyboard language (`InputLocale` in xochitl.conf),
//!    and a character the table cannot produce is never sent: it is removed (or, with
//!    `substitute`, replaced by a readable stand-in) and reported in a `typer_note`.
//! 2. **xochitl ignores keys while the pen is close or a touch is active** (its `DeviceSceneView`
//!    QML treats them as accidental). A reply typed right after the user inked the turn lost its
//!    first ~16 keys on 2026-10-06. The typer holds each write until the pen is out of range and
//!    no finger is down, plus [`CLEAR_MS`] ([`Gate`]).
//! 3. **A pen stroke leaves text mode**, and the first key re-enters it. Before a reply that
//!    follows pen activity or a pause, the typer presses End (a cursor move, no text) and waits
//!    [`PRIME_MS`].
//! 4. **A new paragraph needs a moment**: every write that ends with Enter is followed by at least
//!    `enter_ms` (150 ms by default).
//! 5. **xochitl has to keep up.** The pace is a speed preset, changeable at runtime with a
//!    `typer_config` message (docs/protocol.md).
//!
//! # Speeds
//!
//! A reply becomes a list of [`Burst`]s, each one `write()` of whole key frames followed by a
//! pause. Every keystroke is its own frames (modifiers down, key down, SYN, key up, modifiers up,
//! SYN), as a real keyboard produces them, so no consumer ever sees two keys in one frame. A speed
//! decides only how frames are grouped into writes and how long the pause is:
//!
//! | speed     | one write carries                                          | pause (`char_ms`) |
//! |-----------|------------------------------------------------------------|-------------------|
//! | `careful` | one keystroke                                              | 12 ms             |
//! | `fast`    | a word and its separator, ≤ [`WORD_MAX`] keys              | 12 ms             |
//! | `instant` | up to `burst` keystrokes (default 10), never past an Enter | 40 ms             |
//!
//! `careful` is the pace verified on hardware: ~4.8 s for 400 characters. `fast` is ~0.9 s.
//! `instant` (~1.6 s at its defaults) is **not calibrated yet**: its numbers are conservative
//! guesses until `scripts/dev/typerbench.py` has been run against a scratch text box. Its burst
//! cap rests on an unverified reading of the kernel: evdev gives each reader of a keyboard like
//! this one a 64-event buffer, and a keystroke is 4–6 events.
//!
//! The environment sets the start: `TYPE_SPEED` (`careful|fast|instant`), else `TYPE_BATCH=word`
//! (the older switch) for `fast`, else `careful`; `TYPE_CHAR_MS` (> 0) replaces the preset's
//! pause, `TYPE_BURST` the burst, `TYPE_ENTER_MS` (≥ 0) the Enter settle, `TYPE_SUBSTITUTE=1`
//! turns substitution on, and `TYPE_KEYMAP` (a table name such as `UnitedKingdom`) overrides the
//! keyboard language read from xochitl.conf.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::input::{BTN_TOOL_PEN, BTN_TOOL_RUBBER, BTN_TOUCH, EV_ABS, EV_KEY, EV_SYN, SYN_REPORT};
use crate::keymap::{KEY_ENTER, KEY_LEFTSHIFT, KEY_RIGHTALT, KEY_TAB};

/// Linux key codes the typer presses outside the text tables.
const KEY_SPACE: u16 = 57;
const KEY_END: u16 = 107;
/// The most keystrokes one word burst carries; a longer "word" (a URL, a code line) is split.
pub const WORD_MAX: usize = 16;
/// Instant's keystrokes per write by default (see the overview for why ~10).
pub const BURST_DEFAULT: usize = 10;
/// The largest burst a `typer_config` or `TYPE_BURST` may ask for.
pub const BURST_MAX: usize = WORD_MAX;
/// The longest pause a `typer_config` or `TYPE_CHAR_MS` may ask for, ms.
pub const CHAR_MS_MAX: u32 = 1000;
/// The settle after a write that ends with Enter, ms, by default; and the most one may ask for.
pub const ENTER_MS_DEFAULT: u32 = 150;
pub const ENTER_MS_MAX: u32 = 2000;
/// How long the pen must be out of range and the screen untouched before typing resumes, ms.
pub const CLEAR_MS: i64 = 300;
/// The wait after pressing End to re-enter text mode, ms.
pub const PRIME_MS: u64 = 150;
/// A reply that starts this long after the last typed key is primed even without pen activity.
pub const PRIME_IDLE_MS: i64 = 1000;

// ── speeds ────────────────────────────────────────────────────────────────────────────────────

/// A typing speed preset (`typer_config.speed`, `TYPE_SPEED`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Speed {
    Careful,
    Fast,
    Instant,
}

impl Speed {
    /// The wire name: `careful`, `fast` or `instant`.
    pub fn name(self) -> &'static str {
        match self {
            Speed::Careful => "careful",
            Speed::Fast => "fast",
            Speed::Instant => "instant",
        }
    }

    /// Parses a wire name (case and surrounding space ignored).
    pub fn parse(s: &str) -> Option<Speed> {
        match s.trim().to_ascii_lowercase().as_str() {
            "careful" => Some(Speed::Careful),
            "fast" => Some(Speed::Fast),
            "instant" => Some(Speed::Instant),
            _ => None,
        }
    }

    /// The preset's pause after each write, ms.
    pub fn default_char_ms(self) -> u32 {
        match self {
            Speed::Careful | Speed::Fast => 12,
            Speed::Instant => 40, // uncalibrated: see the overview
        }
    }
}

/// How keystrokes are grouped into writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Batch {
    /// One keystroke per write, a pause after each.
    Key,
    /// One word (with its separator, at most [`WORD_MAX`] keys) per write.
    Word,
    /// Up to this many keystrokes per write; Enter always ends one.
    Burst(usize),
}

/// The typer's current pacing. Shared between the socket reader (which applies `typer_config`)
/// and the typer thread (which reads it before each reply), so a change applies from the next
/// reply on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settings {
    pub speed: Speed,
    /// Pause after each write, ms, 1..=[`CHAR_MS_MAX`].
    pub char_ms: u32,
    /// Keystrokes per write for [`Speed::Instant`], 1..=[`BURST_MAX`].
    pub burst: usize,
    /// The least pause after a write that ends with Enter, ms, 0..=[`ENTER_MS_MAX`].
    pub enter_ms: u32,
    /// Replace characters the keymap cannot type with stand-ins ([`SUBSTITUTE`]) instead of
    /// leaving them out.
    pub substitute: bool,
}

impl Settings {
    /// A preset with its own pause and the defaults for the rest.
    pub fn preset(speed: Speed) -> Settings {
        Settings { speed, char_ms: speed.default_char_ms(), burst: BURST_DEFAULT, enter_ms: ENTER_MS_DEFAULT, substitute: false }
    }

    /// The starting settings from `TYPE_SPEED`, `TYPE_BATCH`, `TYPE_CHAR_MS` (0 = the preset's),
    /// `TYPE_BURST` (0 = the default), `TYPE_ENTER_MS` (negative = the default) and
    /// `TYPE_SUBSTITUTE`, as described in the overview. Out-of-range values are clamped.
    pub fn from_env(speed: Option<&str>, batch: Option<&str>, char_ms: i64, burst: i64, enter_ms: i64, substitute: bool) -> Settings {
        let word = batch.is_some_and(|b| b.trim().eq_ignore_ascii_case("word"));
        let speed = speed.and_then(Speed::parse).unwrap_or(if word { Speed::Fast } else { Speed::Careful });
        let mut s = Settings { substitute, ..Settings::preset(speed) };
        if char_ms > 0 {
            s.char_ms = char_ms.min(CHAR_MS_MAX as i64) as u32;
        }
        if burst > 0 {
            s.burst = (burst as usize).min(BURST_MAX);
        }
        if enter_ms >= 0 {
            s.enter_ms = enter_ms.min(ENTER_MS_MAX as i64) as u32;
        }
        s
    }

    /// How this speed groups keystrokes.
    pub fn batch(&self) -> Batch {
        match self.speed {
            Speed::Careful => Batch::Key,
            Speed::Fast => Batch::Word,
            Speed::Instant => Batch::Burst(self.burst),
        }
    }

    /// The pause after each write.
    pub fn pause(&self) -> Duration {
        Duration::from_millis(self.char_ms as u64)
    }
}

// ── the keymap: xochitl's own tables ────────────────────────────────────────────────────────

/// Modifier bits in the tables (Qt's evdev bits): Shift and AltGr.
pub const MOD_SHIFT: u8 = 1;
pub const MOD_ALTGR: u8 = 2;

/// xochitl's Type Folio tables, generated from libepaper.so (see the overview). Shared with the
/// Go engine, which embeds the same file.
const EPAPER_KEYMAPS: &str = include_str!("../../native/epaper_keymaps.json");

/// Readable stand-ins for characters a table cannot type, used with `substitute`. Brackets
/// become parentheses so structure survives; `^` becomes `**` (a power, as in Python).
pub const SUBSTITUTE: &[(char, &str)] = &[('[', "("), (']', ")"), ('{', "("), ('}', ")"), ('^', "**"), ('~', "-"), ('`', "'")];

/// One keyboard language's table: the key and modifiers that produce each character.
#[derive(Debug)]
pub struct Keymap {
    /// The table's name in libepaper.so (`UnitedStates`, `UnitedKingdom`, …).
    pub name: String,
    /// The printable ASCII this language cannot type at all.
    pub missing: String,
    keys: HashMap<char, (u16, u8)>,
}

#[derive(Deserialize)]
struct TableJson {
    missing: String,
    keys: HashMap<String, (u16, u8)>,
}

impl Keymap {
    /// The table called `name`, or `UnitedStates` when there is none by that name.
    pub fn named(name: &str) -> Keymap {
        let mut all: HashMap<String, TableJson> = serde_json::from_str(EPAPER_KEYMAPS).expect("epaper_keymaps.json");
        let (name, t) = match all.remove(name) {
            Some(t) => (name.to_string(), t),
            None => ("UnitedStates".to_string(), all.remove("UnitedStates").expect("UnitedStates table")),
        };
        let keys = t.keys.into_iter().filter_map(|(c, k)| Some((c.chars().next()?, k))).collect();
        Keymap { name, missing: t.missing, keys }
    }

    /// The key that produces `c`, if any.
    pub fn key(&self, c: char) -> Option<(u16, u8)> {
        self.keys.get(&c).copied()
    }
}

/// The table for xochitl's keyboard language (`InputLocale`, e.g. `en_GB`): English is US unless
/// British; other languages go by their two-letter code. Empty or unknown means `UnitedStates`.
pub fn table_for_locale(input_locale: &str) -> &'static str {
    let l = input_locale.trim().to_ascii_lowercase().replace('-', "_");
    match l.split('_').next().unwrap_or("") {
        "en" if l.ends_with("_gb") || l.ends_with("_uk") => "UnitedKingdom",
        "de" => "Germany",
        "fr" => "France",
        "sv" => "Sweden",
        "nb" | "nn" | "no" => "Norway",
        "da" => "Denmark",
        "es" => "Spain",
        "it" => "Italy",
        _ => "UnitedStates",
    }
}

/// `InputLocale` from the text of xochitl.conf (`/home/root/.config/remarkable/xochitl.conf`),
/// or "" when it is not set.
pub fn input_locale(conf: &str) -> String {
    conf.lines()
        .filter_map(|l| l.trim().strip_prefix("InputLocale="))
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches('"')
        .to_string()
}

/// One key to press: Linux key code and modifier bits.
pub type Keystroke = (u16, u8);

/// The keystrokes that type `s` with `keymap`, and the characters it could not type (in order,
/// with repeats). Newlines become Enter and tabs Tab; typographic dashes, quotes and the ellipsis
/// become their ASCII forms when the table lacks them; with `substitute`, [`SUBSTITUTE`] stands
/// in for the rest where it can. A dead key is never pressed: the tables list none as producers.
pub fn keystrokes(s: &str, keymap: &Keymap, substitute: bool) -> (Vec<Keystroke>, String) {
    let mut out = Vec::with_capacity(s.len());
    let mut dropped = String::new();
    let push = |c: char, out: &mut Vec<Keystroke>| -> bool {
        match c {
            '\n' => out.push((KEY_ENTER, 0)),
            '\t' => out.push((KEY_TAB, 0)),
            c => match keymap.key(c) {
                Some(k) => out.push(k),
                None => return false,
            },
        }
        true
    };
    for c in s.replace("\r\n", "\n").chars() {
        if push(c, &mut out) {
            continue;
        }
        let plain: Option<&str> = match c {
            '…' => Some("..."),
            '—' | '–' | '−' => Some("-"),
            '‘' | '’' => Some("'"),
            '“' | '”' => Some("\""),
            '\u{a0}' => Some(" "),
            _ if substitute => SUBSTITUTE.iter().find(|(k, _)| *k == c).map(|(_, v)| *v),
            _ => None,
        };
        match plain {
            Some(p) if p.chars().all(|pc| keymap.key(pc).is_some()) => {
                for pc in p.chars() {
                    push(pc, &mut out);
                }
            }
            _ => dropped.push(c),
        }
    }
    (out, dropped)
}

// ── the pen and touch gate ──────────────────────────────────────────────────────────────────

/// ABS codes of the multitouch protocol (type B) the touch reader follows.
pub const ABS_MT_SLOT: u16 = 0x2f;
pub const ABS_MT_TRACKING_ID: u16 = 0x39;

/// Whether the user's pen or hand is on the screen, fed by the pen reader and the touch reader
/// and read by the typer before every write (fact 2 of the overview). Lock-free: the readers
/// call it for every event.
pub struct Gate {
    start: Instant,
    pen_tools: AtomicU32, // bit 0 pen, bit 1 rubber: in range
    touches: AtomicU32,   // one bit per multitouch slot (0..32) with a contact
    btn_touch: AtomicBool,
    slot: AtomicU32,
    last_ms: AtomicI64,     // the last pen or touch event, ms since `start`
    activity: AtomicU64,    // counts pen and touch events, for priming
}

impl Gate {
    pub fn new() -> Gate {
        Gate {
            start: Instant::now(),
            pen_tools: AtomicU32::new(0),
            touches: AtomicU32::new(0),
            btn_touch: AtomicBool::new(false),
            slot: AtomicU32::new(0),
            last_ms: AtomicI64::new(-CLEAR_MS),
            activity: AtomicU64::new(0),
        }
    }

    fn now_ms(&self) -> i64 {
        self.start.elapsed().as_millis() as i64
    }

    fn touched(&self, now_ms: i64) {
        self.last_ms.store(now_ms, Ordering::SeqCst);
        self.activity.fetch_add(1, Ordering::SeqCst);
    }

    /// One event from the pen device. Every event counts as activity: the pen reports only while
    /// in range.
    pub fn pen(&self, etype: u16, code: u16, value: i32) {
        self.pen_at(etype, code, value, self.now_ms());
    }

    pub fn pen_at(&self, etype: u16, code: u16, value: i32, now_ms: i64) {
        if etype == EV_KEY && (code == BTN_TOOL_PEN || code == BTN_TOOL_RUBBER) {
            let bit = if code == BTN_TOOL_PEN { 1 } else { 2 };
            if value != 0 {
                self.pen_tools.fetch_or(bit, Ordering::SeqCst);
            } else {
                self.pen_tools.fetch_and(!bit, Ordering::SeqCst);
            }
        }
        if etype != EV_SYN {
            self.touched(now_ms);
        }
    }

    /// One event from the touchscreen (multitouch type B, or BTN_TOUCH).
    pub fn touch(&self, etype: u16, code: u16, value: i32) {
        self.touch_at(etype, code, value, self.now_ms());
    }

    pub fn touch_at(&self, etype: u16, code: u16, value: i32, now_ms: i64) {
        match (etype, code) {
            (EV_ABS, ABS_MT_SLOT) => self.slot.store(value.clamp(0, 31) as u32, Ordering::SeqCst),
            (EV_ABS, ABS_MT_TRACKING_ID) => {
                let bit = 1u32 << self.slot.load(Ordering::SeqCst);
                if value >= 0 {
                    self.touches.fetch_or(bit, Ordering::SeqCst);
                } else {
                    self.touches.fetch_and(!bit, Ordering::SeqCst);
                }
            }
            (EV_KEY, BTN_TOUCH) => self.btn_touch.store(value != 0, Ordering::SeqCst),
            _ => {}
        }
        if etype != EV_SYN {
            self.touched(now_ms);
        }
    }

    /// How long to wait before the next write: zero when the pen is out of range, nothing touches
    /// the screen and neither has for [`CLEAR_MS`]; otherwise the time left (a poll interval
    /// while something is still down).
    pub fn wait(&self) -> Duration {
        self.wait_at(self.now_ms())
    }

    pub fn wait_at(&self, now_ms: i64) -> Duration {
        let down = self.pen_tools.load(Ordering::SeqCst) != 0
            || self.touches.load(Ordering::SeqCst) != 0
            || self.btn_touch.load(Ordering::SeqCst);
        if down {
            return Duration::from_millis(50);
        }
        let left = self.last_ms.load(Ordering::SeqCst) + CLEAR_MS - now_ms;
        Duration::from_millis(left.max(0) as u64)
    }

    /// A counter that moves with every pen or touch event.
    pub fn activity(&self) -> u64 {
        self.activity.load(Ordering::SeqCst)
    }
}

impl Default for Gate {
    fn default() -> Self {
        Self::new()
    }
}

/// The process's one gate: the pen reader, the touch reader and the typer share it.
pub fn gate() -> &'static Gate {
    static GATE: std::sync::OnceLock<Gate> = std::sync::OnceLock::new();
    GATE.get_or_init(Gate::new)
}

// ── typer_config: change and report the speed ───────────────────────────────────────────────

/// A `typer_config` message as the bridge reads it. A request carries no `ok`; an
/// acknowledgement (ours, relayed or replayed by a router) does, and is ignored.
#[derive(Deserialize)]
struct ConfigMsg {
    #[serde(default)]
    t: String,
    speed: Option<String>,
    char_ms: Option<i64>,
    burst: Option<i64>,
    enter_ms: Option<i64>,
    substitute: Option<bool>,
    ok: Option<bool>,
}

/// The acknowledgement: the settings now in force, the keyboard table in use and the ASCII it
/// cannot type; `ok` false (with `error`) for a refused request. Clients show it; routers keep
/// the latest `ok:true` one for late joiners.
pub fn ack(s: &Settings, keymap: &Keymap, error: Option<&str>) -> String {
    let mut v = serde_json::json!({
        "t": "typer_config", "speed": s.speed.name(), "char_ms": s.char_ms, "burst": s.burst,
        "enter_ms": s.enter_ms, "substitute": s.substitute, "keymap": keymap.name,
        "untypeable": keymap.missing, "ok": error.is_none(),
    });
    if let Some(e) = error {
        v["error"] = e.into();
    }
    v.to_string()
}

/// Applies a `typer_config` request to `s` and returns the acknowledgement to send; `None` for
/// anything that is not a request. A request with no fields only asks for the settings. A
/// `speed` resets the pause to that preset's before `char_ms` (if given) adjusts it; the other
/// fields alone adjust the current speed. A bad value refuses the whole request and leaves `s`
/// unchanged.
pub fn apply_config(data: &str, s: &mut Settings, keymap: &Keymap) -> Option<String> {
    let m: ConfigMsg = serde_json::from_str(data).ok()?;
    if m.t != "typer_config" || m.ok.is_some() {
        return None;
    }
    let mut next = *s;
    if let Some(name) = &m.speed {
        let Some(speed) = Speed::parse(name) else {
            return Some(ack(s, keymap, Some("speed must be careful, fast or instant")));
        };
        next.speed = speed;
        next.char_ms = speed.default_char_ms();
    }
    let in_range = |v: i64, lo: i64, hi: u32| (lo..=hi as i64).contains(&v);
    if let Some(ms) = m.char_ms {
        if !in_range(ms, 1, CHAR_MS_MAX) {
            return Some(ack(s, keymap, Some("char_ms must be 1..1000")));
        }
        next.char_ms = ms as u32;
    }
    if let Some(n) = m.burst {
        if !in_range(n, 1, BURST_MAX as u32) {
            return Some(ack(s, keymap, Some("burst must be 1..16")));
        }
        next.burst = n as usize;
    }
    if let Some(ms) = m.enter_ms {
        if !in_range(ms, 0, ENTER_MS_MAX) {
            return Some(ack(s, keymap, Some("enter_ms must be 0..2000")));
        }
        next.enter_ms = ms as u32;
    }
    if let Some(sub) = m.substitute {
        next.substitute = sub;
    }
    *s = next;
    Some(ack(s, keymap, None))
}

/// What the socket reader and the typer thread share: the settings `typer_config` changes, and
/// the keyboard table chosen at start (xochitl reads its keyboard language when it starts too).
pub struct Shared {
    pub settings: std::sync::Mutex<Settings>,
    pub keymap: Keymap,
}

impl Shared {
    pub fn new(settings: Settings, keymap: Keymap) -> Shared {
        Shared { settings: std::sync::Mutex::new(settings), keymap }
    }

    /// The settings now.
    pub fn now(&self) -> Settings {
        *self.settings.lock().unwrap()
    }

    /// The acknowledgement of the settings now (announced on every connection).
    pub fn ack(&self) -> String {
        ack(&self.now(), &self.keymap, None)
    }

    /// [`apply_config`] under the lock.
    pub fn apply(&self, data: &str) -> Option<String> {
        apply_config(data, &mut self.settings.lock().unwrap(), &self.keymap)
    }
}

/// The `typer_note` that tells the session what a reply lost: the characters the keyboard table
/// could not type (docs/protocol.md). The glasses show it next to the terminal.
pub fn note(dropped: &str, keymap: &Keymap) -> String {
    serde_json::json!({"t": "typer_note", "dropped": dropped, "count": dropped.chars().count(), "keymap": keymap.name}).to_string()
}

/// The `typer_config` request a tap in the tablet's dock stands for: a `dock_action` whose `id`
/// is `typer_careful`, `typer_fast` or `typer_instant` (entries listed in
/// `/run/codrawer/dock.json`, docs/protocol.md). The bridge applies it as if the router had sent
/// it; the `dock_action` itself is still relayed like any other.
pub fn dock_request(data: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Action {
        #[serde(default)]
        t: String,
        #[serde(default)]
        id: String,
    }
    let a: Action = serde_json::from_str(data).ok()?;
    let speed = Speed::parse(a.id.strip_prefix("typer_")?).filter(|_| a.t == "dock_action")?;
    Some(serde_json::json!({"t": "typer_config", "speed": speed.name()}).to_string())
}

// ── the plan for one reply ──────────────────────────────────────────────────────────────────

/// One write to the virtual keyboard: input events `(type, code, value)`, then a pause.
#[derive(Debug, PartialEq, Eq)]
pub struct Burst {
    pub events: Vec<(u16, u16, i32)>,
    pub pause: Duration,
}

/// The two frames of one keystroke, with its modifiers held around the key.
fn keystroke_frames((code, mods): Keystroke, out: &mut Vec<(u16, u16, i32)>) {
    let held: Vec<u16> = [(MOD_SHIFT, KEY_LEFTSHIFT), (MOD_ALTGR, KEY_RIGHTALT)]
        .iter()
        .filter(|(bit, _)| mods & bit != 0)
        .map(|(_, k)| *k)
        .collect();
    out.extend(held.iter().map(|&k| (EV_KEY, k, 1)));
    out.push((EV_KEY, code, 1));
    out.push((EV_SYN, SYN_REPORT, 0));
    out.push((EV_KEY, code, 0));
    out.extend(held.iter().rev().map(|&k| (EV_KEY, k, 0)));
    out.push((EV_SYN, SYN_REPORT, 0));
}

/// The write that re-enters xochitl's text mode before a reply: End, then [`PRIME_MS`].
pub fn prime() -> Burst {
    let mut events = Vec::new();
    keystroke_frames((KEY_END, 0), &mut events);
    Burst { events, pause: Duration::from_millis(PRIME_MS) }
}

/// The writes that type `s`, grouped and paced as `how` says, and the characters left out
/// ([`keystrokes`]).
pub fn plan(s: &str, how: &Settings, keymap: &Keymap) -> (Vec<Burst>, String) {
    let (keys, dropped) = keystrokes(s, keymap, how.substitute);
    let (batch, pause) = (how.batch(), how.pause());
    let settle = pause.max(Duration::from_millis(how.enter_ms as u64));
    let mut out = Vec::new();
    let mut cur = Burst { events: Vec::new(), pause };
    let mut n = 0;
    for k in keys {
        keystroke_frames(k, &mut cur.events);
        n += 1;
        let code = k.0;
        let ends = code == KEY_ENTER
            || match batch {
                Batch::Key => true,
                Batch::Word => n >= WORD_MAX || matches!(code, KEY_SPACE | KEY_TAB),
                Batch::Burst(b) => n >= b.max(1),
            };
        if ends {
            if code == KEY_ENTER {
                cur.pause = settle;
            }
            out.push(std::mem::replace(&mut cur, Burst { events: Vec::new(), pause }));
            n = 0;
        }
    }
    if !cur.events.is_empty() {
        out.push(cur);
    }
    (out, dropped)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS12: Duration = Duration::from_millis(12);

    fn how(speed: Speed) -> Settings {
        Settings::preset(speed)
    }

    fn us() -> Keymap {
        Keymap::named("UnitedStates")
    }

    fn plan_us(s: &str, h: &Settings) -> Vec<Burst> {
        plan(s, h, &us()).0
    }

    fn flat(p: Vec<Burst>) -> Vec<(u16, u16, i32)> {
        p.into_iter().flat_map(|b| b.events).collect()
    }

    #[test]
    fn careful_is_one_keystroke_per_write_as_before() {
        let p = plan_us("aB", &how(Speed::Careful));
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].events, vec![(EV_KEY, 30, 1), (EV_SYN, SYN_REPORT, 0), (EV_KEY, 30, 0), (EV_SYN, SYN_REPORT, 0)]);
        assert_eq!(
            p[1].events,
            vec![
                (EV_KEY, KEY_LEFTSHIFT, 1),
                (EV_KEY, 48, 1),
                (EV_SYN, SYN_REPORT, 0),
                (EV_KEY, 48, 0),
                (EV_KEY, KEY_LEFTSHIFT, 0),
                (EV_SYN, SYN_REPORT, 0)
            ]
        );
        assert!(p.iter().all(|b| b.pause == MS12));
    }

    #[test]
    fn fast_groups_a_word_with_its_separator_and_keeps_every_frame() {
        let text = "hello world\nok";
        let p = plan_us(text, &how(Speed::Fast));
        assert_eq!(p.len(), 3); // "hello ", "world\n", "ok"
        let pauses: Vec<_> = p.iter().map(|b| b.pause.as_millis()).collect();
        assert_eq!(pauses, vec![12, ENTER_MS_DEFAULT as u128, 12], "a new paragraph gets its settle");
        let events = flat(p);
        assert_eq!(events, flat(plan_us(text, &how(Speed::Careful))));
        let syns = events.iter().filter(|e| e.0 == EV_SYN).count();
        assert_eq!(syns, 2 * text.chars().count());
    }

    #[test]
    fn long_words_are_split() {
        let p = plan_us(&"x".repeat(40), &how(Speed::Fast));
        assert_eq!(p.iter().map(|b| b.events.len() / 4).collect::<Vec<_>>(), vec![WORD_MAX, WORD_MAX, 8]);
    }

    #[test]
    fn instant_writes_bursts_that_never_cross_an_enter() {
        let text = "ab cd ef gh\nij kl";
        let s = Settings { burst: 5, ..how(Speed::Instant) };
        let p = plan_us(text, &s);
        // "ab cd", " ef g", "h\n", "ij kl"
        assert_eq!(p.iter().map(|b| b.events.len() / 4).collect::<Vec<_>>(), vec![5, 5, 2, 5]);
        assert_eq!(p[2].pause, Duration::from_millis(ENTER_MS_DEFAULT as u64));
        assert_eq!(p[0].pause, Duration::from_millis(40));
        assert_eq!(flat(p), flat(plan_us(text, &how(Speed::Careful))));
    }

    #[test]
    fn enter_settle_never_shortens_the_pause() {
        let s = Settings { char_ms: 300, enter_ms: 150, ..how(Speed::Careful) };
        assert!(plan_us("\n", &s).iter().all(|b| b.pause == Duration::from_millis(300)));
        let s = Settings { enter_ms: 0, ..how(Speed::Careful) };
        assert_eq!(plan_us("\n", &s)[0].pause, MS12);
    }

    #[test]
    fn the_us_table_never_presses_a_dead_key_and_reports_what_it_dropped() {
        let km = us();
        assert_eq!(km.missing, "[]^`{}~");
        let (keys, dropped) = keystrokes("a[i] = x^2 {ok} `~|\\", &km, false);
        assert_eq!(dropped, "[]^{}`~");
        // the dead keys of the US table: 26, 27 (plain and Shift) and Shift+7
        for k in &keys {
            assert!(!matches!(*k, (26, _) | (27, _) | (7, MOD_SHIFT)), "dead key {k:?}");
        }
        assert!(keys.contains(&(43, 0)) && keys.contains(&(43, MOD_SHIFT)), "\\ and | are typeable");
        let (_, kept) = keystrokes("x^2 [a]", &km, true);
        assert_eq!(kept, "", "substitution leaves nothing out");
        let (sub, _) = keystrokes("^", &km, true);
        assert_eq!(sub, vec![(9, MOD_SHIFT), (9, MOD_SHIFT)], "^ becomes **");
        let (typo, d) = keystrokes("a—b…“c”", &km, false);
        assert_eq!(d, "");
        assert_eq!(typo.len(), 9);
    }

    #[test]
    fn tables_follow_the_keyboard_language() {
        assert_eq!(table_for_locale(""), "UnitedStates");
        assert_eq!(table_for_locale("en_US"), "UnitedStates");
        assert_eq!(table_for_locale("en_GB"), "UnitedKingdom");
        assert_eq!(table_for_locale("de_DE"), "Germany");
        assert_eq!(table_for_locale("nb_NO"), "Norway");
        assert_eq!(input_locale("[General]\nInputFlavor=1\nInputLocale=en_GB\n"), "en_GB");
        assert_eq!(input_locale("[General]\n"), "");
        let uk = Keymap::named("UnitedKingdom");
        assert_eq!(uk.missing, "^`~");
        let (_, dropped) = keystrokes("[a]{b}", &uk, false);
        assert_eq!(dropped, "", "the UK table types brackets");
        let de = Keymap::named("Germany");
        let (keys, _) = keystrokes("@", &de, false);
        assert_eq!(keys[0].1, MOD_ALTGR, "German @ is AltGr");
        let mut ev = Vec::new();
        keystroke_frames(keys[0], &mut ev);
        assert_eq!(ev.first(), Some(&(EV_KEY, KEY_RIGHTALT, 1)));
        assert_eq!(Keymap::named("Klingon").name, "UnitedStates");
    }

    #[test]
    fn the_gate_holds_while_the_pen_is_near_or_a_finger_is_down() {
        let g = Gate::new();
        assert_eq!(g.wait_at(10_000), Duration::ZERO, "idle");
        g.pen_at(EV_KEY, BTN_TOOL_PEN, 1, 10_000);
        assert!(g.wait_at(10_100) > Duration::ZERO, "pen in range");
        g.pen_at(EV_KEY, BTN_TOOL_PEN, 0, 10_200);
        assert_eq!(g.wait_at(10_300), Duration::from_millis(200), "300 ms after the pen left");
        assert_eq!(g.wait_at(10_500), Duration::ZERO);
        g.touch_at(EV_ABS, ABS_MT_SLOT, 1, 11_000);
        g.touch_at(EV_ABS, ABS_MT_TRACKING_ID, 7, 11_000);
        assert!(g.wait_at(12_000) > Duration::ZERO, "finger down, however long");
        g.touch_at(EV_ABS, ABS_MT_TRACKING_ID, -1, 12_000);
        assert_eq!(g.wait_at(12_300), Duration::ZERO, "lifted 300 ms ago");
        let a = g.activity();
        g.pen_at(EV_ABS, 0, 5, 13_000);
        assert!(g.activity() > a);
    }

    #[test]
    fn prime_presses_end_and_waits() {
        let p = prime();
        assert_eq!(p.events, vec![(EV_KEY, KEY_END, 1), (EV_SYN, SYN_REPORT, 0), (EV_KEY, KEY_END, 0), (EV_SYN, SYN_REPORT, 0)]);
        assert_eq!(p.pause, Duration::from_millis(PRIME_MS));
    }

    #[test]
    fn settings_from_env() {
        assert_eq!(Settings::from_env(None, None, 0, 0, -1, false), how(Speed::Careful));
        assert_eq!(Settings::from_env(None, Some(" Word "), 0, 0, -1, false).speed, Speed::Fast);
        assert_eq!(Settings::from_env(Some("instant"), Some("word"), 0, 0, -1, false), how(Speed::Instant));
        assert_eq!(
            Settings::from_env(Some("bogus"), None, 8, 99, 0, true),
            Settings { speed: Speed::Careful, char_ms: 8, burst: BURST_MAX, enter_ms: 0, substitute: true }
        );
        assert_eq!(how(Speed::Instant).batch(), Batch::Burst(BURST_DEFAULT));
        assert_eq!(how(Speed::Fast).batch(), Batch::Word);
    }

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn typer_config_sets_speed_and_acknowledges() {
        let km = us();
        let mut s = how(Speed::Careful);
        let a = apply_config(r#"{"t":"typer_config","speed":"fast"}"#, &mut s, &km).unwrap();
        assert_eq!(s, how(Speed::Fast));
        assert_eq!(
            json(&a),
            json(r#"{"t":"typer_config","speed":"fast","char_ms":12,"burst":10,"enter_ms":150,"substitute":false,"keymap":"UnitedStates","untypeable":"[]^`{}~","ok":true}"#)
        );
        apply_config(r#"{"t":"typer_config","speed":"instant","char_ms":15,"burst":8,"enter_ms":300,"substitute":true}"#, &mut s, &km).unwrap();
        assert_eq!(s, Settings { speed: Speed::Instant, char_ms: 15, burst: 8, enter_ms: 300, substitute: true });
        apply_config(r#"{"t":"typer_config","speed":"careful"}"#, &mut s, &km).unwrap();
        assert_eq!(s, Settings { speed: Speed::Careful, char_ms: 12, burst: 8, enter_ms: 300, substitute: true });
        apply_config(r#"{"t":"typer_config","char_ms":20}"#, &mut s, &km).unwrap();
        assert_eq!((s.speed, s.char_ms), (Speed::Careful, 20));
    }

    #[test]
    fn typer_config_query_refusals_and_acks() {
        let km = us();
        let mut s = how(Speed::Fast);
        let q = apply_config(r#"{"t":"typer_config"}"#, &mut s, &km).unwrap();
        assert_eq!(json(&q)["speed"], "fast");
        for bad in [
            r#"{"t":"typer_config","speed":"warp"}"#,
            r#"{"t":"typer_config","char_ms":0}"#,
            r#"{"t":"typer_config","speed":"instant","burst":17}"#,
            r#"{"t":"typer_config","enter_ms":-1}"#,
        ] {
            let a = json(&apply_config(bad, &mut s, &km).unwrap());
            assert_eq!(a["ok"], false, "{bad}");
            assert!(a["error"].is_string());
            assert_eq!(s, how(Speed::Fast), "a refused request changes nothing");
        }
        assert_eq!(apply_config(r#"{"t":"typer_config","speed":"careful","ok":true}"#, &mut s, &km), None);
        assert_eq!(apply_config(r#"{"t":"term","kind":"text","text":"x"}"#, &mut s, &km), None);
        assert_eq!(apply_config("nope", &mut s, &km), None);
        assert_eq!(s, how(Speed::Fast));
    }

    #[test]
    fn dock_taps_stand_for_typer_config_requests() {
        let req = dock_request(r#"{"t":"dock_action","id":"typer_instant","page":"p","source":"dock"}"#).unwrap();
        assert_eq!(json(&req), json(r#"{"t":"typer_config","speed":"instant"}"#));
        assert_eq!(dock_request(r#"{"t":"dock_action","id":"ask_page"}"#), None);
        assert_eq!(dock_request(r#"{"t":"dock_action","id":"typer_warp"}"#), None);
        assert_eq!(dock_request(r#"{"t":"key","id":"typer_fast"}"#), None);
    }

    #[test]
    fn a_note_names_what_was_dropped() {
        assert_eq!(json(&note("[]", &us())), json(r#"{"t":"typer_note","dropped":"[]","count":2,"keymap":"UnitedStates"}"#));
    }
}
