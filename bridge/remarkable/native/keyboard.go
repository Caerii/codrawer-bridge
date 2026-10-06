package main

// Keyboard input: a keyboard paired to the tablet becomes `key` messages in the session.
//
// A Bluetooth (or USB) keyboard bonded to the tablet appears as another /dev/input/eventN node
// with a "kbd" handler (pairing: docs/remarkable_bluetooth.md). This file finds it, reads its
// EV_KEY events, tracks modifiers, maps a US layout to characters, and emits (docs/protocol.md):
//
//	{"t":"key","key":"A","char":"A","code":30,"repeat":false,
//	 "mods":{"shift":true,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}
//
// Only key-down and auto-repeat are emitted (a key-up carries no text). `char` is present only
// for text-producing keys with no Ctrl/Alt/Meta held; `key` is the character, or a browser-style
// name for the rest (Enter, Backspace, ArrowUp, F3, …). Clients own line editing and commands.
//
// The device is not grabbed by default, so the tablet's own UI keeps receiving the keys too;
// -keyboard-grab makes the bridge the only consumer. The keyboard comes and goes (BLE keyboards
// sleep; boot/keyboard-keeper.sh reconnects them), so the reader reopens the node on error and
// keeps waiting for it to reappear.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"codrawer-bridge-native/pen"

	"golang.org/x/sys/unix"
)

// keyMods is the modifier state sent with every key.
type keyMods struct {
	Shift bool `json:"shift"`
	Ctrl  bool `json:"ctrl"`
	Alt   bool `json:"alt"`
	Meta  bool `json:"meta"`
}

// outKey is one `key` message. TS is Unix ms on the tablet's clock, taken when the key was read.
type outKey struct {
	T      string  `json:"t"`
	Key    string  `json:"key"`
	Char   string  `json:"char,omitempty"`
	Code   uint16  `json:"code"` // the Linux key code
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

// usKeymap maps a key code to [base, shifted] for printable keys. The typer uses it in reverse
// (uinput.go).
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

// ── finding the keyboard ────────────────────────────────────────────────────

// findKeyboardDevice picks the event node of a keyboard: a device with a "kbd" handler that is
// not the tablet's own power key or a virtual keyboard, preferring one whose name says
// "keyboard". An explicit path wins.
func findKeyboardDevice(explicit string) (string, error) {
	if explicit != "" && explicit != "auto" {
		return explicit, nil
	}
	if path := pickKeyboard(listProcInputDevices()); path != "" {
		return path, nil
	}
	return "", errors.New("no keyboard input device found (pair one with bluetoothctl, or pass -keyboard /dev/input/eventN)")
}

// pickKeyboard applies findKeyboardDevice's rules to a device list ("" if none qualifies).
func pickKeyboard(devices []inputDeviceInfo) string {
	var fallback string
	for _, d := range devices {
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
			return path
		}
		if fallback == "" {
			fallback = path
		}
	}
	return fallback
}

// ── reading it ──────────────────────────────────────────────────────────────

// keyboardRescan is, with inotify, the longest the keyboard reader sleeps before rescanning.
const keyboardRescan = 60 * time.Second

// inputNodes waits for a keyboard to appear. Most of the time none is connected (the Paper
// Pro's Bluetooth is dormant unless brought up), so this is the keyboard reader's idle state:
// it sleeps until a node appears in /dev/input (inotify), with a keyboardRescan net, instead of
// rescanning /proc every 5 s. Without inotify it rescans every 5 s, as before.
type inputNodes struct {
	ino *inotify // nil: no inotify
}

func newInputNodes() *inputNodes {
	ino, err := newInotify()
	if err != nil {
		return &inputNodes{}
	}
	if _, err := ino.add("/dev/input", unix.IN_CREATE|unix.IN_MOVED_TO|unix.IN_ATTRIB|unix.IN_ONLYDIR); err != nil {
		ino.close()
		return &inputNodes{}
	}
	return &inputNodes{ino: ino}
}

// wait sleeps until /dev/input changes (or the rescan net), or 5 s without inotify.
func (n *inputNodes) wait() {
	if n.ino == nil {
		time.Sleep(5 * time.Second)
		return
	}
	if _, err := n.ino.wait(time.Now().Add(keyboardRescan)); err != nil {
		n.ino.close()
		n.ino = nil
		time.Sleep(5 * time.Second)
	}
}

// runKeyboardForever reads the keyboard and pushes key messages into out. It never returns;
// when the device is missing it waits for one to appear (inputNodes), when it drops it reopens
// after 2 s.
func runKeyboardForever(explicit string, grab bool, debug bool, out chan<- outKey) {
	nodes := newInputNodes()
	for {
		path, err := findKeyboardDevice(explicit)
		if err != nil {
			if debug {
				fmt.Printf("[keyboard] %v; waiting for an input device\n", err)
			}
			nodes.wait()
			continue
		}
		fmt.Printf("[keyboard] using input device: %s\n", path)
		err = readKeyboardOnce(path, grab, debug, out)
		fmt.Printf("[keyboard] device closed (%v); reopening in 2s\n", err)
		time.Sleep(2 * time.Second)
	}
}

// readKeyboardOnce reads one open keyboard until a read fails. A full out channel (nobody
// draining while disconnected) drops the key rather than blocking the reader.
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
	var dec keyDecoder

	for {
		chunk := make([]byte, 4096)
		n, err := reader.Read(chunk)
		if err != nil {
			return err
		}
		parser.feed(chunk[:n], func(ev pen.Event) {
			if ev.Type != pen.EvKey {
				return
			}
			k, ok := dec.decode(ev.Code, ev.Value, nowMS)
			if !ok {
				return
			}
			if debug {
				fmt.Printf("[keyboard] key=%q char=%q code=%d repeat=%v shift=%v ctrl=%v\n", k.Key, k.Char, k.Code, k.Repeat, k.Mods.Shift, k.Mods.Ctrl)
			}
			select {
			case out <- k:
			default:
			}
		})
	}
}

// nowMS is the wall clock in Unix ms.
func nowMS() int64 { return time.Now().UnixMilli() }

// ── decoding ────────────────────────────────────────────────────────────────

// keyDecoder turns EV_KEY events into `key` messages, tracking modifiers and Caps Lock. Its zero
// value is a keyboard with nothing held.
type keyDecoder struct {
	mods     keyMods
	capsLock bool
}

// decode consumes one EV_KEY event (value 0 up, 1 down, 2 auto-repeat) and returns the message
// for it, if any. Modifiers and Caps Lock only change state; key-ups produce nothing. now stamps
// the message.
func (d *keyDecoder) decode(code uint16, value int32, now func() int64) (outKey, bool) {
	down := value != 0
	switch code {
	case KEY_LEFTSHIFT, KEY_RIGHTSHIFT:
		d.mods.Shift = down
		return outKey{}, false
	case KEY_LEFTCTRL, KEY_RIGHTCTRL:
		d.mods.Ctrl = down
		return outKey{}, false
	case KEY_LEFTALT, KEY_RIGHTALT:
		d.mods.Alt = down
		return outKey{}, false
	case KEY_LEFTMETA, KEY_RIGHTMETA:
		d.mods.Meta = down
		return outKey{}, false
	case KEY_CAPSLOCK:
		if value == 1 {
			d.capsLock = !d.capsLock
		}
		return outKey{}, false
	}
	if value == 0 {
		return outKey{}, false // key-up carries no text
	}
	k := outKey{T: "key", Code: code, Repeat: value == 2, Mods: d.mods, TS: now()}
	if pair, ok := usKeymap[code]; ok {
		upper := d.mods.Shift
		if d.capsLock && len(pair[0]) == 1 && pair[0][0] >= 'a' && pair[0][0] <= 'z' {
			upper = !upper // Caps Lock inverts Shift for letters only
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
		if d.mods.Ctrl || d.mods.Alt || d.mods.Meta {
			k.Char = "" // a chord, not text
		}
	} else if name, ok := namedKeys[code]; ok {
		k.Key = name
	} else {
		k.Key = fmt.Sprintf("Unidentified(%d)", code)
	}
	return k, true
}
