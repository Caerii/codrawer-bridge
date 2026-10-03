package main

// A virtual keyboard (Linux uinput) for typing text INTO the tablet.
//
// The reMarkable UI accepts keyboard input into its text boxes (notebook text layers, the Type
// Folio flow). By registering a virtual keyboard the bridge can type replies into whatever field
// the user has focused (typer.go). Nothing touches the display driver, and xochitl cannot tell
// the device from a real keyboard.
//
// Setup is UI_SET_EVBIT / UI_SET_KEYBIT / UI_DEV_SETUP / UI_DEV_CREATE (uinput.h constants
// inlined below). Events are written as raw input_event records of 24 bytes (aarch64 timeval 16 +
// type 2 + code 2 + value 4); the kernel stamps the time itself, so it is left zero. The device
// registers on BUS_VIRTUAL under virtualKeyboardName, which is how the keyboard finder
// (keyboard.go) knows to skip it.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"codrawer-bridge-native/pen"
)

const (
	uiSetEvBit  = 0x40045564 // _IOW(UINPUT_IOCTL_BASE, 100, int)
	uiSetKeyBit = 0x40045565 // _IOW(UINPUT_IOCTL_BASE, 101, int)
	uiDevCreate = 0x00005501 // _IO(UINPUT_IOCTL_BASE, 1)
	uiDevSetup  = 0x405c5503 // _IOW(UINPUT_IOCTL_BASE, 3, struct uinput_setup) — 92 bytes
	busVirtual  = 0x06
)

// Key codes the typer produces outside the US keymap.
const (
	keyEnter = 28
	keyTab   = 15
)

// uinputSetup mirrors struct uinput_setup: input_id (4×u16), name[80], ff_effects_max u32.
type uinputSetup struct {
	Bustype, Vendor, Product, Version uint16
	Name                              [80]byte
	FFEffectsMax                      uint32
}

// VirtualKeyboard is an open uinput keyboard device.
type VirtualKeyboard struct {
	f *os.File
}

// OpenVirtualKeyboard creates a keyboard named name that can press every ordinary key (codes
// 1–127). It waits 300 ms before returning, because the kernel needs a moment to register the new
// input node before it delivers events.
func OpenVirtualKeyboard(name string) (*VirtualKeyboard, error) {
	f, err := os.OpenFile("/dev/uinput", os.O_WRONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	fd := f.Fd()
	if err := ioctlInt(fd, uiSetEvBit, pen.EvKey); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_EVBIT: %w", err)
	}
	if err := ioctlInt(fd, uiSetEvBit, pen.EvSyn); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_EVBIT syn: %w", err)
	}
	for code := 1; code < 128; code++ { // every ordinary keyboard key
		if err := ioctlInt(fd, uiSetKeyBit, code); err != nil {
			f.Close()
			return nil, fmt.Errorf("UI_SET_KEYBIT %d: %w", code, err)
		}
	}
	var setup uinputSetup
	setup.Bustype = busVirtual
	setup.Vendor = 0x5349  // "SI"
	setup.Product = 0x4742 // "GB"
	setup.Version = 1
	copy(setup.Name[:], name)
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, fd, uiDevSetup, uintptr(unsafe.Pointer(&setup))); errno != 0 {
		f.Close()
		return nil, fmt.Errorf("UI_DEV_SETUP: %w", errno)
	}
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, fd, uiDevCreate, 0); errno != 0 {
		f.Close()
		return nil, fmt.Errorf("UI_DEV_CREATE: %w", errno)
	}
	time.Sleep(300 * time.Millisecond)
	return &VirtualKeyboard{f: f}, nil
}

func ioctlInt(fd uintptr, req uintptr, val int) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, fd, req, uintptr(val))
	if errno != 0 {
		return errno
	}
	return nil
}

// TypeText types s, pausing perChar after every keystroke so the UI keeps up. Newlines become
// Enter, tabs Tab; see keystrokes for what else is substituted or dropped.
func (k *VirtualKeyboard) TypeText(s string, perChar time.Duration) error {
	for _, ks := range keystrokes(s) {
		if err := k.press(ks.code, ks.shift); err != nil {
			return err
		}
		time.Sleep(perChar)
	}
	return nil
}

// Close removes the virtual keyboard.
func (k *VirtualKeyboard) Close() error {
	if k == nil || k.f == nil {
		return errors.New("closed")
	}
	return k.f.Close()
}

// press sends one key press and release (with Shift held around it if asked), each half closed
// by a SYN_REPORT.
func (k *VirtualKeyboard) press(code int, shift bool) error {
	if shift {
		if err := k.emit(pen.EvKey, KEY_LEFTSHIFT, 1); err != nil {
			return err
		}
	}
	if err := k.emit(pen.EvKey, uint16(code), 1); err != nil {
		return err
	}
	if err := k.emit(pen.EvSyn, pen.SynReport, 0); err != nil {
		return err
	}
	if err := k.emit(pen.EvKey, uint16(code), 0); err != nil {
		return err
	}
	if shift {
		if err := k.emit(pen.EvKey, KEY_LEFTSHIFT, 0); err != nil {
			return err
		}
	}
	return k.emit(pen.EvSyn, pen.SynReport, 0)
}

// emit writes one input_event record.
func (k *VirtualKeyboard) emit(etype, code uint16, value int32) error {
	var ev [24]byte
	binary.LittleEndian.PutUint16(ev[16:18], etype)
	binary.LittleEndian.PutUint16(ev[18:20], code)
	binary.LittleEndian.PutUint32(ev[20:24], uint32(value))
	_, err := k.f.Write(ev[:])
	return err
}

// ── text → keystrokes ───────────────────────────────────────────────────────

// keystroke is one key to press, with or without Shift.
type keystroke struct {
	code  int
	shift bool
}

// charToKey inverts usKeymap: character → (code, shift index). Some characters sit on two keys:
// the digits and - . / * + are on both the main keyboard and the keypad. The typer must never use
// the keypad: with NumLock off xochitl may read those keys as navigation (arrows, Home/End). So a
// keypad key is used only for a character no main-keyboard key produces, and among main keys an
// unshifted one wins. Codes are walked in ascending order so the result never depends on Go's
// random map order (it used to).
var charToKey = func() map[rune][2]int {
	codes := make([]int, 0, len(usKeymap))
	for code := range usKeymap {
		codes = append(codes, int(code))
	}
	sort.Ints(codes)
	m := map[rune][2]int{}
	for _, keypad := range []bool{false, true} { // main keyboard first, keypad only as a fallback
		for _, code := range codes {
			if isKeypad(code) != keypad {
				continue
			}
			for i, s := range usKeymap[uint16(code)] {
				for _, r := range s {
					prev, ok := m[r]
					if !ok || (!keypad && i == 0 && prev[1] == 1 && !isKeypad(prev[0])) {
						m[r] = [2]int{code, i}
					}
				}
			}
		}
	}
	return m
}()

// isKeypad reports whether a Linux key code is on the numeric keypad (KP_ASTERISK 55,
// KP_7…KP_DOT 71–83, KP_ENTER 96, KP_SLASH 98).
func isKeypad(code int) bool {
	return code == 55 || (code >= 71 && code <= 83) || code == 96 || code == 98
}

// keystrokes maps text to the keys a US layout needs for it. CRLF and LF are Enter, tab is Tab.
// Typography the model likes is folded to ASCII (dashes to '-', curly quotes to straight ones,
// '…' to "..."), and any other character the layout cannot produce is dropped.
func keystrokes(s string) []keystroke {
	var out []keystroke
	for _, r := range strings.ReplaceAll(s, "\r\n", "\n") {
		switch r {
		case '\n':
			out = append(out, keystroke{keyEnter, false})
			continue
		case '\t':
			out = append(out, keystroke{keyTab, false})
			continue
		case '…':
			out = append(out, keystrokes("...")...)
			continue
		}
		pair, ok := charToKey[r]
		if !ok {
			switch r {
			case '—', '–':
				pair, ok = charToKey['-']
			case '‘', '’':
				pair, ok = charToKey['\'']
			case '“', '”':
				pair, ok = charToKey['"']
			}
		}
		if !ok {
			continue
		}
		out = append(out, keystroke{pair[0], pair[1] == 1})
	}
	return out
}
