//! How the typer turns a reply into writes to the virtual keyboard, and how fast (typer.go).
//!
//! The typer types terminal replies into xochitl's focused text field through a uinput keyboard
//! (`linux::VirtualKeyboard`). xochitl has to keep up, so the keystrokes are paced. This module
//! decides the pacing, portably and testably, in two parts: the typing **speed** (a preset the
//! user picks, changeable at runtime with a `typer_config` message, docs/protocol.md) and the
//! **plan** that speed implies for one reply.
//!
//! # What xochitl accepts (measured 2026-10-06)
//!
//! One run at `careful` into a scratch text box, read back from the saved `.rm`
//! (docs/investigations/keyboard-latency.md, "Typer"):
//!
//! - Letters, digits and ``@#$%&*()-_=+;:'",.<>/?|`` arrived complete and in order.
//! - ``^ [ ] { } ` ~`` never arrived, at any pace: xochitl's text field produces nothing for
//!   those keys. [`untypable`] lists them; [`plan`] leaves them out instead of sending keys
//!   that do nothing, and the typer logs what it skipped.
//! - The first ~16 keys of the reply, right after a leading Enter, were lost. Either xochitl
//!   drops keys while it lays out a new paragraph, or a leading `--` triggers some autoformat;
//!   the next calibration run tells the two apart. Until then every write that ends with Enter
//!   is followed by at least `enter_ms` (150 ms) so a new paragraph can settle.
//!
//! # Speeds
//!
//! A reply becomes a list of [`Burst`]s, each one `write()` of whole key frames followed by a
//! pause. Every keystroke is always its own frames (Shift down, key down, SYN, key up, Shift up,
//! SYN), exactly the event stream a real keyboard produces, so no consumer ever sees two keys in
//! one frame. A speed only decides how frames are grouped into writes and how long the pause is:
//!
//! | speed     | one write carries                                   | pause after it (`char_ms`) |
//! |-----------|-----------------------------------------------------|----------------------------|
//! | `careful` | one keystroke                                       | 12 ms                      |
//! | `fast`    | a word and its separator, ≤ [`WORD_MAX`] keys       | 12 ms                      |
//! | `instant` | up to `burst` keystrokes (default 10), never past an Enter | 40 ms               |
//!
//! `careful` is the pacing verified on hardware: ~4.8 s for 400 characters. `fast` is ~0.9 s for
//! 400 characters of ~70 words. `instant` (~1.6 s for 400 characters at its defaults, ~0.4 s at
//! 10 ms) is **not calibrated yet**: its defaults are conservative guesses until xochitl's real
//! limit is measured. The burst cap rests on an unverified reading of the kernel: evdev gives
//! each reader of a keyboard like this one a buffer of 64 events, and a keystroke is 4 events (6
//! with Shift), so a write of more than ~10 keystrokes can overflow it if xochitl is not reading
//! at that moment, and the kernel then drops the buffer.
//!
//! The environment sets the speed the bridge starts with: `TYPE_SPEED` (`careful|fast|instant`),
//! else `TYPE_BATCH=word` (the older switch) for `fast`, else `careful`; `TYPE_CHAR_MS` (when > 0)
//! replaces the preset's pause, `TYPE_BURST` the instant burst size and `TYPE_ENTER_MS` (when ≥ 0)
//! the settle after Enter.

use std::time::Duration;

use serde::Deserialize;

use crate::input::{EV_KEY, EV_SYN, SYN_REPORT};
use crate::keymap::{text_to_keystrokes, KEY_ENTER, KEY_LEFTSHIFT, KEY_TAB};

/// Linux key code of the space bar.
const KEY_SPACE: u16 = 57;
/// The most keystrokes one word burst carries; a longer "word" (a URL, a code line) is split.
pub const WORD_MAX: usize = 16;
/// Instant's keystrokes per write by default (see the module overview for why ~10).
pub const BURST_DEFAULT: usize = 10;
/// The largest burst a `typer_config` or `TYPE_BURST` may ask for.
pub const BURST_MAX: usize = WORD_MAX;
/// The longest pause a `typer_config` or `TYPE_CHAR_MS` may ask for, ms.
pub const CHAR_MS_MAX: u32 = 1000;
/// The settle after a write that ends with Enter, ms, by default; and the most one may ask for.
pub const ENTER_MS_DEFAULT: u32 = 150;
pub const ENTER_MS_MAX: u32 = 2000;
/// Characters xochitl's text field produces nothing for (measured; module overview).
pub const XOCHITL_DROPS: &str = "^[]{}`~";

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
            Speed::Instant => 40, // uncalibrated: see the module overview
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
}

impl Settings {
    /// A preset with its own pause, the default burst and the default Enter settle.
    pub fn preset(speed: Speed) -> Settings {
        Settings { speed, char_ms: speed.default_char_ms(), burst: BURST_DEFAULT, enter_ms: ENTER_MS_DEFAULT }
    }

    /// The starting settings from `TYPE_SPEED`, `TYPE_BATCH`, `TYPE_CHAR_MS` (0 = the preset's),
    /// `TYPE_BURST` (0 = the default) and `TYPE_ENTER_MS` (negative = the default), as described
    /// in the module overview. Out-of-range values are clamped.
    pub fn from_env(speed: Option<&str>, batch: Option<&str>, char_ms: i64, burst: i64, enter_ms: i64) -> Settings {
        let word = batch.is_some_and(|b| b.trim().eq_ignore_ascii_case("word"));
        let speed = speed.and_then(Speed::parse).unwrap_or(if word { Speed::Fast } else { Speed::Careful });
        let mut s = Settings::preset(speed);
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
    ok: Option<bool>,
}

/// The acknowledgement: the settings now in force, `ok` false (with `error`) for a refused
/// request. Clients show it; routers keep the latest `ok:true` one for late joiners.
pub fn ack(s: &Settings, error: Option<&str>) -> String {
    let mut v = serde_json::json!({
        "t": "typer_config", "speed": s.speed.name(), "char_ms": s.char_ms, "burst": s.burst,
        "enter_ms": s.enter_ms, "ok": error.is_none(),
    });
    if let Some(e) = error {
        v["error"] = e.into();
    }
    v.to_string()
}

/// Applies a `typer_config` request to `s` and returns the acknowledgement to send; `None` for
/// anything that is not a request. A request with no fields only asks for the settings. A
/// `speed` resets the pause to that preset's before `char_ms` (if given) adjusts it; `char_ms`,
/// `burst` or `enter_ms` alone adjust the current speed. A bad value refuses the whole request
/// and leaves `s` unchanged.
pub fn apply_config(data: &str, s: &mut Settings) -> Option<String> {
    let m: ConfigMsg = serde_json::from_str(data).ok()?;
    if m.t != "typer_config" || m.ok.is_some() {
        return None;
    }
    let mut next = *s;
    if let Some(name) = &m.speed {
        let Some(speed) = Speed::parse(name) else {
            return Some(ack(s, Some("speed must be careful, fast or instant")));
        };
        next.speed = speed;
        next.char_ms = speed.default_char_ms();
    }
    let in_range = |v: i64, lo: i64, hi: u32| (lo..=hi as i64).contains(&v);
    if let Some(ms) = m.char_ms {
        if !in_range(ms, 1, CHAR_MS_MAX) {
            return Some(ack(s, Some("char_ms must be 1..1000")));
        }
        next.char_ms = ms as u32;
    }
    if let Some(n) = m.burst {
        if !in_range(n, 1, BURST_MAX as u32) {
            return Some(ack(s, Some("burst must be 1..16")));
        }
        next.burst = n as usize;
    }
    if let Some(ms) = m.enter_ms {
        if !in_range(ms, 0, ENTER_MS_MAX) {
            return Some(ack(s, Some("enter_ms must be 0..2000")));
        }
        next.enter_ms = ms as u32;
    }
    *s = next;
    Some(ack(s, None))
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

/// The characters of `s` the plan leaves out because xochitl drops them ([`XOCHITL_DROPS`]).
pub fn untypable(s: &str) -> String {
    s.chars().filter(|c| XOCHITL_DROPS.contains(*c)).collect()
}

/// The two frames of one keystroke, with Shift around the key when needed.
fn keystroke_frames(code: u16, shift: bool, out: &mut Vec<(u16, u16, i32)>) {
    if shift {
        out.push((EV_KEY, KEY_LEFTSHIFT, 1));
    }
    out.push((EV_KEY, code, 1));
    out.push((EV_SYN, SYN_REPORT, 0));
    out.push((EV_KEY, code, 0));
    if shift {
        out.push((EV_KEY, KEY_LEFTSHIFT, 0));
    }
    out.push((EV_SYN, SYN_REPORT, 0));
}

/// The writes that type `s` (US layout, see [`text_to_keystrokes`]; [`untypable`] characters
/// left out), grouped and paced as `how` says.
pub fn plan(s: &str, how: &Settings) -> Vec<Burst> {
    let typable: String = s.chars().filter(|c| !XOCHITL_DROPS.contains(*c)).collect();
    let (batch, pause) = (how.batch(), how.pause());
    let settle = pause.max(Duration::from_millis(how.enter_ms as u64));
    let mut out = Vec::new();
    let mut cur = Burst { events: Vec::new(), pause };
    let mut keys = 0;
    for (code, shift) in text_to_keystrokes(&typable) {
        keystroke_frames(code, shift, &mut cur.events);
        keys += 1;
        let ends = code == KEY_ENTER
            || match batch {
                Batch::Key => true,
                Batch::Word => keys >= WORD_MAX || matches!(code, KEY_SPACE | KEY_TAB),
                Batch::Burst(n) => keys >= n.max(1),
            };
        if ends {
            if code == KEY_ENTER {
                cur.pause = settle;
            }
            out.push(std::mem::replace(&mut cur, Burst { events: Vec::new(), pause }));
            keys = 0;
        }
    }
    if !cur.events.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS12: Duration = Duration::from_millis(12);

    fn how(speed: Speed) -> Settings {
        Settings::preset(speed)
    }

    fn flat(p: Vec<Burst>) -> Vec<(u16, u16, i32)> {
        p.into_iter().flat_map(|b| b.events).collect()
    }

    #[test]
    fn careful_is_one_keystroke_per_write_as_before() {
        let p = plan("aB", &how(Speed::Careful));
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
        let p = plan(text, &how(Speed::Fast));
        assert_eq!(p.len(), 3); // "hello ", "world\n", "ok"
        let pauses: Vec<_> = p.iter().map(|b| b.pause.as_millis()).collect();
        assert_eq!(pauses, vec![12, ENTER_MS_DEFAULT as u128, 12], "a new paragraph gets its settle");
        // the same events, in the same order, as one keystroke per write
        let events = flat(p);
        assert_eq!(events, flat(plan(text, &how(Speed::Careful))));
        // every key is down and up in frames of its own: one SYN per press and per release
        let syns = events.iter().filter(|e| e.0 == EV_SYN).count();
        assert_eq!(syns, 2 * text.chars().count());
    }

    #[test]
    fn long_words_are_split() {
        let p = plan(&"x".repeat(40), &how(Speed::Fast));
        assert_eq!(p.iter().map(|b| b.events.len() / 4).collect::<Vec<_>>(), vec![WORD_MAX, WORD_MAX, 8]);
    }

    #[test]
    fn instant_writes_bursts_that_never_cross_an_enter() {
        let text = "ab cd ef gh\nij kl";
        let s = Settings { burst: 5, ..how(Speed::Instant) };
        let p = plan(text, &s);
        // "ab cd", " ef g", "h\n", "ij kl"
        assert_eq!(p.iter().map(|b| b.events.len() / 4).collect::<Vec<_>>(), vec![5, 5, 2, 5]);
        assert_eq!(p[2].pause, Duration::from_millis(ENTER_MS_DEFAULT as u64));
        assert_eq!(p[0].pause, Duration::from_millis(40));
        assert_eq!(flat(p), flat(plan(text, &how(Speed::Careful))));
    }

    #[test]
    fn characters_xochitl_drops_are_left_out() {
        assert_eq!(untypable("a^[b]{c}`~d\\|"), "^[]{}`~");
        assert_eq!(flat(plan("a{b}~", &how(Speed::Careful))), flat(plan("ab", &how(Speed::Careful))));
    }

    #[test]
    fn enter_settle_never_shortens_the_pause() {
        let s = Settings { char_ms: 300, enter_ms: 150, ..how(Speed::Careful) };
        assert!(plan("\n", &s).iter().all(|b| b.pause == Duration::from_millis(300)));
        let s = Settings { enter_ms: 0, ..how(Speed::Careful) };
        assert_eq!(plan("\n", &s)[0].pause, MS12);
    }

    #[test]
    fn settings_from_env() {
        assert_eq!(Settings::from_env(None, None, 0, 0, -1), how(Speed::Careful));
        assert_eq!(Settings::from_env(None, Some(" Word "), 0, 0, -1).speed, Speed::Fast);
        assert_eq!(Settings::from_env(Some("instant"), Some("word"), 0, 0, -1), how(Speed::Instant));
        assert_eq!(
            Settings::from_env(Some("bogus"), None, 8, 99, 0),
            Settings { speed: Speed::Careful, char_ms: 8, burst: BURST_MAX, enter_ms: 0 }
        );
        assert_eq!(how(Speed::Instant).batch(), Batch::Burst(BURST_DEFAULT));
        assert_eq!(how(Speed::Fast).batch(), Batch::Word);
    }

    fn json(s: &str) -> serde_json::Value {
        serde_json::from_str(s).unwrap()
    }

    #[test]
    fn typer_config_sets_speed_and_acknowledges() {
        let mut s = how(Speed::Careful);
        let a = apply_config(r#"{"t":"typer_config","speed":"fast"}"#, &mut s).unwrap();
        assert_eq!(s, how(Speed::Fast));
        assert_eq!(json(&a), json(r#"{"t":"typer_config","speed":"fast","char_ms":12,"burst":10,"enter_ms":150,"ok":true}"#));
        // a speed resets the pause to its preset's; char_ms, burst and enter_ms then adjust it
        apply_config(r#"{"t":"typer_config","speed":"instant","char_ms":15,"burst":8,"enter_ms":300}"#, &mut s).unwrap();
        assert_eq!(s, Settings { speed: Speed::Instant, char_ms: 15, burst: 8, enter_ms: 300 });
        apply_config(r#"{"t":"typer_config","speed":"careful"}"#, &mut s).unwrap();
        assert_eq!(s, Settings { speed: Speed::Careful, char_ms: 12, burst: 8, enter_ms: 300 });
        // char_ms alone keeps the speed
        apply_config(r#"{"t":"typer_config","char_ms":20}"#, &mut s).unwrap();
        assert_eq!((s.speed, s.char_ms), (Speed::Careful, 20));
    }

    #[test]
    fn typer_config_query_refusals_and_acks() {
        let mut s = how(Speed::Fast);
        let q = apply_config(r#"{"t":"typer_config"}"#, &mut s).unwrap();
        assert_eq!(json(&q)["speed"], "fast");
        for bad in [
            r#"{"t":"typer_config","speed":"warp"}"#,
            r#"{"t":"typer_config","char_ms":0}"#,
            r#"{"t":"typer_config","speed":"instant","burst":17}"#,
            r#"{"t":"typer_config","enter_ms":-1}"#,
        ] {
            let a = json(&apply_config(bad, &mut s).unwrap());
            assert_eq!(a["ok"], false, "{bad}");
            assert!(a["error"].is_string());
            assert_eq!(s, how(Speed::Fast), "a refused request changes nothing");
        }
        // acknowledgements (ours echoed, or replayed) and other messages are not requests
        assert_eq!(apply_config(r#"{"t":"typer_config","speed":"careful","ok":true}"#, &mut s), None);
        assert_eq!(apply_config(r#"{"t":"term","kind":"text","text":"x"}"#, &mut s), None);
        assert_eq!(apply_config("nope", &mut s), None);
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
}
