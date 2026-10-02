package main

// Keyboard input for the Paper Pro bridge.
//
// A Bluetooth (or USB) keyboard bonded to the tablet appears as another
// /dev/input/eventN node with a "kbd" handler. This file finds it, reads its
// EV_KEY events, tracks modifiers, maps a US layout to characters, and emits
// `key` messages into the session alongside the pen strokes:
//
//   {"t":"key","key":"a","char":"A","code":30,"repeat":false,
//    "mods":{"shift":true,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}
//
// Only key-down and auto-repeat are emitted (a key-up carries no text). The
// device is not grabbed by default, so the tablet's own UI keeps receiving the
// keys too; -keyboard-grab makes the bridge the only consumer.
//
// The keyboard comes and goes (sleep, range), so the reader reopens the node
// on error and keeps waiting for it to reappear.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type keyMods struct {
	Shift bool `json:"shift"`
	Ctrl  bool `json:"ctrl"`
	Alt   bool `json:"alt"`
	Meta  bool `json:"meta"`
}

type outKey struct {
	T      string  `json:"t"`
	Key    string  `json:"key"`
	Char   string  `json:"char,omitempty"`
	Code   uint16  `json:"code"`
	Repeat bool    `json:"repeat"`
	Mods   keyMods `json:"mods"`
	TS     int64   `json:"ts"`
}

// Linux key codes (input-event-codes.h) that matter for modifier tracking.
const (
	KEY_LEFTCTRL   = 29
	KEY_LEFTSHIFT  = 42
	KEY_RIGHTSHIFT = 54
	KEY_LEFTALT    = 56
	KEY_CAPSLOCK   = 58
	KEY_RIGHTCTRL  = 97
	KEY_RIGHTALT   = 100
	KEY_LEFTMETA   = 125
	KEY_RIGHTMETA  = 126
)

// usKeymap maps a key code to [base, shifted] for printable keys.
var usKeymap = map[uint16][2]string{
	2: {"1", "!"}, 3: {"2", "@"}, 4: {"3", "#"}, 5: {"4", "$"}, 6: {"5", "%"},
	7: {"6", "^"}, 8: {"7", "&"}, 9: {"8", "*"}, 10: {"9", "("}, 11: {"0", ")"},
	12: {"-", "_"}, 13: {"=", "+"},
	16: {"q", "Q"}, 17: {"w", "W"}, 18: {"e", "E"}, 19: {"r", "R"}, 20: {"t", "T"},
	21: {"y", "Y"}, 22: {"u", "U"}, 23: {"i", "I"}, 24: {"o", "O"}, 25: {"p", "P"},
	26: {"[", "{"}, 27: {"]", "}"},
	30: {"a", "A"}, 31: {"s", "S"}, 32: {"d", "D"}, 33: {"f", "F"}, 34: {"g", "G"},
	35: {"h", "H"}, 36: {"j", "J"}, 37: {"k", "K"}, 38: {"l", "L"}, 39: {";", ":"},
	40: {"'", "\""}, 41: {"`", "~"}, 43: {"\\", "|"},
	44: {"z", "Z"}, 45: {"x", "X"}, 46: {"c", "C"}, 47: {"v", "V"}, 48: {"b", "B"},
	49: {"n", "N"}, 50: {"m", "M"}, 51: {",", "<"}, 52: {".", ">"}, 53: {"/", "?"},
	57: {" ", " "},
	// keypad
	71: {"7", "7"}, 72: {"8", "8"}, 73: {"9", "9"}, 74: {"-", "-"}, 75: {"4", "4"},
	76: {"5", "5"}, 77: {"6", "6"}, 78: {"+", "+"}, 79: {"1", "1"}, 80: {"2", "2"},
	81: {"3", "3"}, 82: {"0", "0"}, 83: {".", "."}, 98: {"/", "/"}, 55: {"*", "*"},
}

// namedKeys maps non-printable key codes to browser-style key names.
var namedKeys = map[uint16]string{
	1: "Escape", 14: "Backspace", 15: "Tab", 28: "Enter", 96: "Enter",
	58: "CapsLock", 59: "F1", 60: "F2", 61: "F3", 62: "F4", 63: "F5", 64: "F6",
	65: "F7", 66: "F8", 67: "F9", 68: "F10", 87: "F11", 88: "F12",
	102: "Home", 103: "ArrowUp", 104: "PageUp", 105: "ArrowLeft", 106: "ArrowRight",
	107: "End", 108: "ArrowDown", 109: "PageDown", 110: "Insert", 111: "Delete",
	29: "Control", 97: "Control", 42: "Shift", 54: "Shift", 56: "Alt", 100: "Alt",
	125: "Meta", 126: "Meta", 119: "Pause", 70: "ScrollLock", 69: "NumLock",
	113: "AudioVolumeMute", 114: "AudioVolumeDown", 115: "AudioVolumeUp",
	163: "MediaTrackNext", 164: "MediaPlayPause", 165: "MediaTrackPrevious",
	158: "BrowserBack", 172: "BrowserHome", 224: "BrightnessDown", 225: "BrightnessUp",
}

// virtualKeyboardName is the uinput device the typer creates (-type-replies). Auto-detect
// must skip it: at boot it exists before any Bluetooth keyboard connects, and reading it
// would both hide the real keyboard and echo typed replies back as keystrokes.
const virtualKeyboardName = "codrawer virtual keyboard"

// findKeyboardDevice picks the event node of a keyboard: a device with a
// "kbd" handler that is not the tablet's own power key or our virtual keyboard.
// An explicit path wins.
func findKeyboardDevice(explicit string) (string, error) {
	if explicit != "" && explicit != "auto" {
		return explicit, nil
	}
	var fallback string
	for _, d := range listProcInputDevices() {
		hasKbd := false
		event := ""
		for _, h := range d.handlers {
			if h == "kbd" {
				hasKbd = true
			}
			if strings.HasPrefix(h, "event") {
				event = h
			}
		}
		if !hasKbd || event == "" {
			continue
		}
		lname := strings.ToLower(d.name)
		// Skip the power key, our own typer, and any other virtual (uinput) keyboard: e.g.
		// smart_remarkable's typist would otherwise be streamed as the user's keystrokes.
		if strings.Contains(lname, "powerkey") || strings.Contains(lname, "power button") ||
			lname == virtualKeyboardName || d.virtual {
			continue
		}
		path := filepath.Join("/dev/input", event)
		if strings.Contains(lname, "keyboard") {
			return path, nil
		}
		if fallback == "" {
			fallback = path
		}
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", errors.New("no keyboard input device found (pair one with bluetoothctl, or pass -keyboard /dev/input/eventN)")
}

// runKeyboardForever reads the keyboard and pushes key messages into out.
// It never returns; when the device is missing or drops, it retries.
func runKeyboardForever(explicit string, grab bool, debug bool, out chan<- outKey) {
	for {
		path, err := findKeyboardDevice(explicit)
		if err != nil {
			if debug {
				fmt.Printf("[keyboard] %v; retrying in 5s\n", err)
			}
			time.Sleep(5 * time.Second)
			continue
		}
		fmt.Printf("[keyboard] using input device: %s\n", path)
		err = readKeyboardOnce(path, grab, debug, out)
		fmt.Printf("[keyboard] device closed (%v); reopening in 2s\n", err)
		time.Sleep(2 * time.Second)
	}
}

func readKeyboardOnce(path string, grab bool, debug bool, out chan<- outKey) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if grab {
		tryGrab(int(f.Fd()))
	}
	reader := bufio.NewReaderSize(f, 4096)
	parser := &inputParser{}
	var mods keyMods
	capsLock := false

	for {
		chunk := make([]byte, 4096)
		n, err := reader.Read(chunk)
		if err != nil {
			return err
		}
		parser.feed(chunk[:n], func(etype uint16, code uint16, value int32) {
			if etype != EV_KEY {
				return
			}
			down := value != 0
			switch code {
			case KEY_LEFTSHIFT, KEY_RIGHTSHIFT:
				mods.Shift = down
				return
			case KEY_LEFTCTRL, KEY_RIGHTCTRL:
				mods.Ctrl = down
				return
			case KEY_LEFTALT, KEY_RIGHTALT:
				mods.Alt = down
				return
			case KEY_LEFTMETA, KEY_RIGHTMETA:
				mods.Meta = down
				return
			case KEY_CAPSLOCK:
				if value == 1 {
					capsLock = !capsLock
				}
				return
			}
			if value == 0 {
				return // key-up carries no text
			}
			k := outKey{T: "key", Code: code, Repeat: value == 2, Mods: mods, TS: nowMS()}
			if pair, ok := usKeymap[code]; ok {
				upper := mods.Shift
				if capsLock && len(pair[0]) == 1 && pair[0][0] >= 'a' && pair[0][0] <= 'z' {
					upper = !upper
				}
				if upper {
					k.Char = pair[1]
				} else {
					k.Char = pair[0]
				}
				k.Key = k.Char
				if k.Char == " " {
					k.Key = "Space"
				}
				if mods.Ctrl || mods.Alt || mods.Meta {
					k.Char = "" // a chord, not text
				}
			} else if name, ok := namedKeys[code]; ok {
				k.Key = name
			} else {
				k.Key = fmt.Sprintf("Unidentified(%d)", code)
			}
			if debug {
				fmt.Printf("[keyboard] key=%q char=%q code=%d repeat=%v shift=%v ctrl=%v\n", k.Key, k.Char, k.Code, k.Repeat, mods.Shift, mods.Ctrl)
			}
			select {
			case out <- k:
			default:
				// nobody draining (disconnected); drop rather than block the reader
			}
		})
	}
}
