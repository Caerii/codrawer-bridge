//! Keyboard → `key` messages, and text → keystrokes for the virtual keyboard (keyboard.go,
//! uinput.go). Portable: the device readers in `linux` feed events through [`KeyTranslator`].

use serde::Serialize;

use crate::input::EV_KEY;
use crate::util::now_ms;

pub const KEY_ESC: u16 = 1;
pub const KEY_TAB: u16 = 15;
pub const KEY_ENTER: u16 = 28;
pub const KEY_LEFTCTRL: u16 = 29;
pub const KEY_LEFTSHIFT: u16 = 42;
pub const KEY_RIGHTSHIFT: u16 = 54;
pub const KEY_LEFTALT: u16 = 56;
pub const KEY_CAPSLOCK: u16 = 58;
pub const KEY_RIGHTCTRL: u16 = 97;
pub const KEY_RIGHTALT: u16 = 100;
pub const KEY_LEFTMETA: u16 = 125;
pub const KEY_RIGHTMETA: u16 = 126;

/// The uinput device the typer creates (-type-replies). Auto-detect must skip it: at boot it
/// exists before any Bluetooth keyboard connects, and reading it would both hide the real
/// keyboard and echo typed replies back as keystrokes.
pub const VIRTUAL_KEYBOARD_NAME: &str = "codrawer virtual keyboard";

const KEYPAD: &[u16] = &[55, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 98];

/// US layout: key code → (base, shifted) for printable keys.
pub fn us_keymap(code: u16) -> Option<(&'static str, &'static str)> {
    Some(match code {
        2 => ("1", "!"), 3 => ("2", "@"), 4 => ("3", "#"), 5 => ("4", "$"), 6 => ("5", "%"),
        7 => ("6", "^"), 8 => ("7", "&"), 9 => ("8", "*"), 10 => ("9", "("), 11 => ("0", ")"),
        12 => ("-", "_"), 13 => ("=", "+"),
        16 => ("q", "Q"), 17 => ("w", "W"), 18 => ("e", "E"), 19 => ("r", "R"), 20 => ("t", "T"),
        21 => ("y", "Y"), 22 => ("u", "U"), 23 => ("i", "I"), 24 => ("o", "O"), 25 => ("p", "P"),
        26 => ("[", "{"), 27 => ("]", "}"),
        30 => ("a", "A"), 31 => ("s", "S"), 32 => ("d", "D"), 33 => ("f", "F"), 34 => ("g", "G"),
        35 => ("h", "H"), 36 => ("j", "J"), 37 => ("k", "K"), 38 => ("l", "L"), 39 => (";", ":"),
        40 => ("'", "\""), 41 => ("`", "~"), 43 => ("\\", "|"),
        44 => ("z", "Z"), 45 => ("x", "X"), 46 => ("c", "C"), 47 => ("v", "V"), 48 => ("b", "B"),
        49 => ("n", "N"), 50 => ("m", "M"), 51 => (",", "<"), 52 => (".", ">"), 53 => ("/", "?"),
        57 => (" ", " "),
        // keypad
        71 => ("7", "7"), 72 => ("8", "8"), 73 => ("9", "9"), 74 => ("-", "-"), 75 => ("4", "4"),
        76 => ("5", "5"), 77 => ("6", "6"), 78 => ("+", "+"), 79 => ("1", "1"), 80 => ("2", "2"),
        81 => ("3", "3"), 82 => ("0", "0"), 83 => (".", "."), 98 => ("/", "/"), 55 => ("*", "*"),
        _ => return None,
    })
}

/// Browser-style names for non-printable keys.
pub fn named_key(code: u16) -> Option<&'static str> {
    Some(match code {
        1 => "Escape", 14 => "Backspace", 15 => "Tab", 28 | 96 => "Enter",
        58 => "CapsLock", 59 => "F1", 60 => "F2", 61 => "F3", 62 => "F4", 63 => "F5", 64 => "F6",
        65 => "F7", 66 => "F8", 67 => "F9", 68 => "F10", 87 => "F11", 88 => "F12",
        102 => "Home", 103 => "ArrowUp", 104 => "PageUp", 105 => "ArrowLeft", 106 => "ArrowRight",
        107 => "End", 108 => "ArrowDown", 109 => "PageDown", 110 => "Insert", 111 => "Delete",
        29 | 97 => "Control", 42 | 54 => "Shift", 56 | 100 => "Alt",
        125 | 126 => "Meta", 119 => "Pause", 70 => "ScrollLock", 69 => "NumLock",
        113 => "AudioVolumeMute", 114 => "AudioVolumeDown", 115 => "AudioVolumeUp",
        163 => "MediaTrackNext", 164 => "MediaPlayPause", 165 => "MediaTrackPrevious",
        158 => "BrowserBack", 172 => "BrowserHome", 224 => "BrightnessDown", 225 => "BrightnessUp",
        _ => return None,
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct KeyMods {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

/// `{"t":"key","key":"a","char":"A","code":30,"repeat":false,"mods":{...},"ts":...}`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutKey {
    pub t: &'static str,
    pub key: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub char: String,
    pub code: u16,
    pub repeat: bool,
    pub mods: KeyMods,
    pub ts: i64,
}

/// Tracks modifiers and caps lock for one keyboard and turns EV_KEY events into key messages.
/// Only key-down and auto-repeat produce a message (a key-up carries no text).
#[derive(Debug, Default)]
pub struct KeyTranslator {
    pub mods: KeyMods,
    caps_lock: bool,
}

impl KeyTranslator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, etype: u16, code: u16, value: i32) -> Option<OutKey> {
        if etype != EV_KEY {
            return None;
        }
        let down = value != 0;
        match code {
            KEY_LEFTSHIFT | KEY_RIGHTSHIFT => {
                self.mods.shift = down;
                return None;
            }
            KEY_LEFTCTRL | KEY_RIGHTCTRL => {
                self.mods.ctrl = down;
                return None;
            }
            KEY_LEFTALT | KEY_RIGHTALT => {
                self.mods.alt = down;
                return None;
            }
            KEY_LEFTMETA | KEY_RIGHTMETA => {
                self.mods.meta = down;
                return None;
            }
            KEY_CAPSLOCK => {
                if value == 1 {
                    self.caps_lock = !self.caps_lock;
                }
                return None;
            }
            _ => {}
        }
        if value == 0 {
            return None;
        }
        let mods = self.mods;
        let mut k = OutKey {
            t: "key",
            key: String::new(),
            char: String::new(),
            code,
            repeat: value == 2,
            mods,
            ts: now_ms(),
        };
        if let Some((base, shifted)) = us_keymap(code) {
            let mut upper = mods.shift;
            if self.caps_lock && base.len() == 1 && base.as_bytes()[0].is_ascii_lowercase() {
                upper = !upper;
            }
            k.char = if upper { shifted } else { base }.to_string();
            k.key = if k.char == " " { "Space".to_string() } else { k.char.clone() };
            if mods.ctrl || mods.alt || mods.meta {
                k.char.clear(); // a chord, not text
            }
        } else if let Some(name) = named_key(code) {
            k.key = name.to_string();
        } else {
            k.key = format!("Unidentified({code})");
        }
        Some(k)
    }
}

/// character → (code, shift). Inverts the US keymap preferring the main block over the keypad
/// (keypad codes depend on NumLock) and the unshifted key over the shifted one.
///
/// Deliberate deviation: Go builds this from a randomly ordered map, so a digit could map to its
/// keypad key on one run and the main row on the next; here the choice is fixed.
pub fn char_to_key(c: char) -> Option<(u16, bool)> {
    let mut best: Option<(u16, bool, u8)> = None; // rank: 0 main base, 1 main shifted, 2 keypad
    for code in 1..=127u16 {
        let Some((base, shifted)) = us_keymap(code) else { continue };
        let keypad = KEYPAD.contains(&code);
        for (s, shift) in [(base, false), (shifted, true)] {
            if s.starts_with(c) {
                let rank = if keypad { 2 } else if shift { 1 } else { 0 };
                if best.map_or(true, |(_, _, r)| rank < r) {
                    best = Some((code, shift, rank));
                }
            }
        }
    }
    best.map(|(code, shift, _)| (code, shift))
}

/// The keystrokes that type `s` on a US layout: newline → Enter, tab → Tab, typographic dashes
/// and quotes folded to ASCII, `…` → `...`, anything else the layout can't produce dropped.
/// The typer no longer presses these: xochitl translates keys with its own tables, so
/// [`crate::typer::keystrokes`] types from those. This stays as the US-PC reference.
pub fn text_to_keystrokes(s: &str) -> Vec<(u16, bool)> {
    let mut out = Vec::with_capacity(s.len());
    for r in s.replace("\r\n", "\n").chars() {
        let r = match r {
            '\n' => {
                out.push((KEY_ENTER, false));
                continue;
            }
            '\t' => {
                out.push((KEY_TAB, false));
                continue;
            }
            '…' => {
                out.extend(std::iter::repeat(char_to_key('.').expect("dot")).take(3));
                continue;
            }
            '—' | '–' => '-',
            '‘' | '’' => '\'',
            '“' | '”' => '"',
            other => other,
        };
        if let Some(k) = char_to_key(r) {
            out.push(k);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_and_caps_lock() {
        let mut t = KeyTranslator::new();
        assert_eq!(t.feed(EV_KEY, KEY_LEFTSHIFT, 1), None);
        let k = t.feed(EV_KEY, 30, 1).unwrap();
        assert_eq!((k.key.as_str(), k.char.as_str(), k.mods.shift), ("A", "A", true));
        t.feed(EV_KEY, KEY_LEFTSHIFT, 0);
        t.feed(EV_KEY, KEY_CAPSLOCK, 1);
        assert_eq!(t.feed(EV_KEY, 30, 1).unwrap().char, "A");
        assert_eq!(t.feed(EV_KEY, 2, 1).unwrap().char, "1"); // caps lock only affects letters
        assert_eq!(t.feed(EV_KEY, 30, 0), None); // key-up
    }

    #[test]
    fn chords_names_and_space() {
        let mut t = KeyTranslator::new();
        t.feed(EV_KEY, KEY_LEFTCTRL, 1);
        let k = t.feed(EV_KEY, 46, 1).unwrap();
        assert_eq!((k.key.as_str(), k.char.as_str()), ("c", ""));
        t.feed(EV_KEY, KEY_LEFTCTRL, 0);
        let k = t.feed(EV_KEY, 57, 2).unwrap();
        assert_eq!((k.key.as_str(), k.char.as_str(), k.repeat), ("Space", " ", true));
        assert_eq!(t.feed(EV_KEY, 28, 1).unwrap().key, "Enter");
        assert_eq!(t.feed(EV_KEY, 240, 1).unwrap().key, "Unidentified(240)");
        let json = serde_json::to_string(&t.feed(EV_KEY, 103, 1).unwrap()).unwrap();
        assert!(json.starts_with(r#"{"t":"key","key":"ArrowUp","code":103,"repeat":false,"mods":{"shift":false,"#), "{json}");
    }

    #[test]
    fn text_maps_to_main_block_keys() {
        assert_eq!(char_to_key('7'), Some((8, false)));
        assert_eq!(char_to_key('*'), Some((9, true)));
        assert_eq!(char_to_key('+'), Some((13, true)));
        assert_eq!(char_to_key('A'), Some((30, true)));
        assert_eq!(char_to_key('é'), None);
        assert_eq!(
            text_to_keystrokes("a\r\n—…"),
            vec![(30, false), (KEY_ENTER, false), (12, false), (52, false), (52, false), (52, false)]
        );
    }
}
