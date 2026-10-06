//! How the typer turns a reply into writes to the virtual keyboard (typer.go, uinput.go).
//!
//! The typer types terminal replies into xochitl's focused text field through a uinput keyboard
//! (`linux::VirtualKeyboard`). xochitl has to keep up: the keystrokes are paced, by default one
//! every `TYPE_CHAR_MS` (12 ms), which is the pacing verified on hardware (CLAUDE.md, "Where
//! things stand"). A 400-character answer therefore takes ~4.8 s to appear.
//!
//! This module plans the writes, portably and testably: a reply becomes a list of [`Burst`]s,
//! each one `write()` of whole key frames followed by a pause. Every keystroke is always its own
//! frame (Shift down, key down, SYN, key up, Shift up, SYN), exactly the event stream a real
//! keyboard produces, so no consumer ever sees two keys in one frame. What changes with the mode
//! is only how frames are grouped into writes and where the pauses go:
//!
//! - [`Batch::Key`] (default): one keystroke per write, `per_char` after each: unchanged
//!   behaviour, and still the default because faster typing into xochitl has not been verified
//!   on the device yet (docs/investigations/keyboard-latency.md, "Typer").
//! - [`Batch::Word`] (`TYPE_BATCH=word`): a word and the separator that ends it (space, Enter,
//!   Tab), at most [`WORD_MAX`] keystrokes, in one write, then one `per_char` pause. A 400-character
//!   reply of ~70 words goes in ~0.9 s instead of ~4.8 s.

use std::time::Duration;

use crate::input::{EV_KEY, EV_SYN, SYN_REPORT};
use crate::keymap::{text_to_keystrokes, KEY_ENTER, KEY_LEFTSHIFT, KEY_TAB};

/// Linux key code of the space bar.
const KEY_SPACE: u16 = 57;
/// The most keystrokes one word burst carries; a longer "word" (a URL, a code line) is split.
pub const WORD_MAX: usize = 16;

/// How keystrokes are grouped into writes (`TYPE_BATCH`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Batch {
    /// One keystroke per write, a pause after each.
    Key,
    /// One word per write, a pause after each word.
    Word,
}

impl Batch {
    /// `TYPE_BATCH`: `word` selects [`Batch::Word`]; anything else (or unset) is [`Batch::Key`].
    pub fn from_env_value(v: Option<&str>) -> Batch {
        match v.map(|s| s.trim().to_ascii_lowercase()) {
            Some(s) if s == "word" => Batch::Word,
            _ => Batch::Key,
        }
    }
}

/// One write to the virtual keyboard: input events `(type, code, value)`, then a pause.
#[derive(Debug, PartialEq, Eq)]
pub struct Burst {
    pub events: Vec<(u16, u16, i32)>,
    pub pause: Duration,
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

/// The writes that type `s` (US layout, see [`text_to_keystrokes`]), paced by `per_char`.
pub fn plan(s: &str, per_char: Duration, batch: Batch) -> Vec<Burst> {
    let mut out = Vec::new();
    let mut cur = Burst { events: Vec::new(), pause: per_char };
    let mut keys = 0;
    for (code, shift) in text_to_keystrokes(s) {
        keystroke_frames(code, shift, &mut cur.events);
        keys += 1;
        let ends = match batch {
            Batch::Key => true,
            Batch::Word => keys >= WORD_MAX || matches!(code, KEY_SPACE | KEY_ENTER | KEY_TAB),
        };
        if ends {
            out.push(std::mem::replace(&mut cur, Burst { events: Vec::new(), pause: per_char }));
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

    #[test]
    fn key_mode_is_one_keystroke_per_write_as_before() {
        let p = plan("aB", MS12, Batch::Key);
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
    fn word_mode_groups_a_word_with_its_separator_and_keeps_every_frame() {
        let text = "hello world\nok";
        let p = plan(text, MS12, Batch::Word);
        assert_eq!(p.len(), 3); // "hello ", "world\n", "ok"
        // the same events, in the same order, as one keystroke per write
        let flat: Vec<_> = p.iter().flat_map(|b| b.events.clone()).collect();
        let keyed: Vec<_> = plan(text, MS12, Batch::Key).into_iter().flat_map(|b| b.events).collect();
        assert_eq!(flat, keyed);
        // every key is down and up in frames of its own: one SYN per press and per release
        let syns = flat.iter().filter(|e| e.0 == EV_SYN).count();
        assert_eq!(syns, 2 * text.chars().count());
    }

    #[test]
    fn long_words_are_split() {
        let p = plan(&"x".repeat(40), MS12, Batch::Word);
        assert_eq!(p.iter().map(|b| b.events.len() / 4).collect::<Vec<_>>(), vec![WORD_MAX, WORD_MAX, 8]);
    }

    #[test]
    fn batch_from_env() {
        assert_eq!(Batch::from_env_value(Some(" Word ")), Batch::Word);
        assert_eq!(Batch::from_env_value(Some("key")), Batch::Key);
        assert_eq!(Batch::from_env_value(None), Batch::Key);
    }
}
