package main

// Virtual keyboard (Linux uinput) for typing text INTO the tablet.
//
// The reMarkable UI accepts keyboard input into its text boxes (notebook text
// layers, the Type Folio flow). By registering a virtual keyboard we can type
// terminal / AI replies into whatever field the user has focused, so a
// `/term` question typed on the paired keyboard and its answer both end up in
// the tablet's own document. Nothing touches the display driver.
//
// Wire format: input_event on aarch64 is 24 bytes (timeval 16 + type 2 +
// code 2 + value 4). Setup uses UI_SET_EVBIT / UI_SET_KEYBIT / UI_DEV_SETUP /
// UI_DEV_CREATE (input-event-codes and uinput.h constants inlined below).

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

const (
	uiSetEvBit  = 0x40045564 // _IOW(UINPUT_IOCTL_BASE, 100, int)
	uiSetKeyBit = 0x40045565 // _IOW(UINPUT_IOCTL_BASE, 101, int)
	uiDevCreate = 0x00005501 // _IO(UINPUT_IOCTL_BASE, 1)
	uiDevSetup  = 0x405c5503 // _IOW(UINPUT_IOCTL_BASE, 3, struct uinput_setup) — 92 bytes
	busVirtual  = 0x06
)

// uinputSetup mirrors struct uinput_setup: input_id (4×u16), name[80], ff_effects_max u32.
type uinputSetup struct {
	Bustype, Vendor, Product, Version uint16
	Name                              [80]byte
	FFEffectsMax                      uint32
}

type VirtualKeyboard struct {
	f *os.File
}

// charToKey inverts usKeymap: character → (code, shift).
var charToKey = func() map[rune][2]int {
	m := map[rune][2]int{}
	for code, pair := range usKeymap {
		for i, s := range pair {
			for _, r := range s {
				if _, ok := m[r]; !ok || i == 0 {
					m[r] = [2]int{int(code), i}
				}
			}
		}
	}
	return m
}()

func OpenVirtualKeyboard(name string) (*VirtualKeyboard, error) {
	f, err := os.OpenFile("/dev/uinput", os.O_WRONLY|unix.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	fd := f.Fd()
	if err := ioctlInt(fd, uiSetEvBit, EV_KEY); err != nil {
		f.Close()
		return nil, fmt.Errorf("UI_SET_EVBIT: %w", err)
	}
	if err := ioctlInt(fd, uiSetEvBit, EV_SYN); err != nil {
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
	setup.Vendor = 0x5349 // "SI"
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
	// The kernel needs a moment to register the new input node before it delivers events.
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

func (k *VirtualKeyboard) emit(etype, code uint16, value int32) error {
	var ev [24]byte
	binary.LittleEndian.PutUint16(ev[16:18], etype)
	binary.LittleEndian.PutUint16(ev[18:20], code)
	binary.LittleEndian.PutUint32(ev[20:24], uint32(value))
	_, err := k.f.Write(ev[:])
	return err
}

func (k *VirtualKeyboard) press(code int, shift bool) error {
	if shift {
		if err := k.emit(EV_KEY, KEY_LEFTSHIFT, 1); err != nil {
			return err
		}
	}
	if err := k.emit(EV_KEY, uint16(code), 1); err != nil {
		return err
	}
	if err := k.emit(EV_SYN, SYN_REPORT, 0); err != nil {
		return err
	}
	if err := k.emit(EV_KEY, uint16(code), 0); err != nil {
		return err
	}
	if shift {
		if err := k.emit(EV_KEY, KEY_LEFTSHIFT, 0); err != nil {
			return err
		}
	}
	return k.emit(EV_SYN, SYN_REPORT, 0)
}

// TypeText types s, mapping newlines to Enter and dropping characters the US
// layout cannot produce. perChar paces the keystrokes so the UI keeps up.
func (k *VirtualKeyboard) TypeText(s string, perChar time.Duration) error {
	for _, r := range strings.ReplaceAll(s, "\r\n", "\n") {
		var code, shift int
		switch r {
		case '\n':
			code = 28
		case '\t':
			code = 15
		default:
			pair, ok := charToKey[r]
			if !ok {
				if r == '—' || r == '–' {
					pair, ok = charToKey['-']
				} else if r == '‘' || r == '’' {
					pair, ok = charToKey['\'']
				} else if r == '“' || r == '”' {
					pair, ok = charToKey['"']
				} else if r == '…' {
					if err := k.TypeText("...", perChar); err != nil {
						return err
					}
					continue
				}
			}
			if !ok {
				continue
			}
			code, shift = pair[0], pair[1]
		}
		if err := k.press(code, shift == 1); err != nil {
			return err
		}
		time.Sleep(perChar)
	}
	return nil
}

func (k *VirtualKeyboard) Close() error {
	if k == nil || k.f == nil {
		return errors.New("closed")
	}
	return k.f.Close()
}
