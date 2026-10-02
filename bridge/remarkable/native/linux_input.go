package main

// Linux input plumbing:
// - constants for event codes we care about
// - ioctl helpers to read ABS axis ranges and optionally EVIOCGRAB
// - parsing input_event stream (16B vs 24B timeval size)

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/unix"

	"codrawer-bridge-native/pen"
)

// Minimal Linux input constants
const (
	EV_SYN = 0x00
	EV_KEY = 0x01
	EV_ABS = 0x03
)

// Keys (stylus tools)
const (
	BTN_TOUCH       = 0x14A
	BTN_TOOL_PEN    = 0x140
	BTN_TOOL_RUBBER = 0x141
)

// ABS axes
const (
	ABS_X        = 0x00
	ABS_Y        = 0x01
	ABS_PRESSURE = 0x18
	ABS_DISTANCE = 0x19
)

// SYN codes
const (
	SYN_REPORT = 0x00
)

type absInfo struct {
	Value      int32
	Min        int32
	Max        int32
	Fuzz       int32
	Flat       int32
	Resolution int32
}


// ioctl request encoding (Linux _IOC macro)
const (
	iocNRBits   = 8
	iocTypeBits = 8
	iocSizeBits = 14
	iocDirBits  = 2

	iocNRShift   = 0
	iocTypeShift = iocNRShift + iocNRBits
	iocSizeShift = iocTypeShift + iocTypeBits
	iocDirShift  = iocSizeShift + iocSizeBits

	iocWrite = 1
	iocRead  = 2
)

func ioc(dir uint32, typ uint32, nr uint32, size uint32) uintptr {
	return uintptr((dir << iocDirShift) | (typ << iocTypeShift) | (nr << iocNRShift) | (size << iocSizeShift))
}

func evioCGAbs(absCode int) uintptr {
	// EVIOCGABS(abs) = _IOR('E', 0x40 + abs, struct input_absinfo)
	return ioc(iocRead, uint32('E'), uint32(0x40+absCode), uint32(unsafe.Sizeof(absInfo{})))
}

func evioCGrab() uintptr {
	// EVIOCGRAB = _IOW('E', 0x90, int)
	return ioc(iocWrite, uint32('E'), uint32(0x90), uint32(unsafe.Sizeof(int32(0))))
}

func getAbsInfo(fd int, absCode int) (absInfo, error) {
	var info absInfo
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), evioCGAbs(absCode), uintptr(unsafe.Pointer(&info)))
	if errno != 0 {
		return absInfo{}, errno
	}
	return info, nil
}

func getRanges(fd int) pen.Ranges {
	x, errX := getAbsInfo(fd, ABS_X)
	y, errY := getAbsInfo(fd, ABS_Y)
	p, errP := getAbsInfo(fd, ABS_PRESSURE)
	r := pen.Ranges{XMin: 0, XMax: 1, YMin: 0, YMax: 1, PMin: 0, PMax: 4096}
	if errX == nil {
		r.XMin, r.XMax = x.Min, x.Max
	}
	if errY == nil {
		r.YMin, r.YMax = y.Min, y.Max
	}
	if errP == nil {
		r.PMin, r.PMax = p.Min, p.Max
	}
	return r
}

// getKeyBits reads the device's current key state (EVIOCGKEY): bit k of the result is key k.
func getKeyBits(fd int) ([96]byte, error) {
	var bits [96]byte // KEY_MAX 0x2ff → 96 bytes
	req := ioc(iocRead, uint32('E'), 0x18, uint32(len(bits)))
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), req, uintptr(unsafe.Pointer(&bits[0])))
	if errno != 0 {
		return bits, errno
	}
	return bits, nil
}

func tryGrab(fd int) {
	var one int32 = 1
	_, _, _ = unix.Syscall(unix.SYS_IOCTL, uintptr(fd), evioCGrab(), uintptr(unsafe.Pointer(&one)))
}

// inputParser parses Linux input_event structs from a stream.
// Kernel uses different struct size depending on timeval size (32-bit vs 64-bit).
type inputParser struct {
	buf []byte
	sz  int // 0 unknown, else 16 or 24
}

func (p *inputParser) feed(chunk []byte, cb func(etype uint16, code uint16, value int32)) {
	p.feedTimed(chunk, func(ev pen.Event) { cb(ev.Type, ev.Code, ev.Value) })
}

// feedTimed parses events with their kernel timestamps (Unix ms). The struct size follows the
// platform's timeval: 24 bytes where long is 64-bit (the Paper Pro is aarch64), else 16. The
// old guess from the first read's length misread 48-byte reads of 16-byte events.
func (p *inputParser) feedTimed(chunk []byte, cb func(ev pen.Event)) {
	if p.sz == 0 {
		p.sz = 16
		if unsafe.Sizeof(uintptr(0)) == 8 {
			p.sz = 24
		}
	}
	if len(p.buf) == 0 {
		p.buf = chunk // common case: whole events, no copy
	} else {
		p.buf = append(p.buf, chunk...)
	}
	for len(p.buf) >= p.sz {
		ev := p.buf[:p.sz]
		p.buf = p.buf[p.sz:]
		var e pen.Event
		if p.sz == 24 {
			sec := int64(binary.LittleEndian.Uint64(ev[0:8]))
			usec := int64(binary.LittleEndian.Uint64(ev[8:16]))
			e = pen.Event{
				Type:   binary.LittleEndian.Uint16(ev[16:18]),
				Code:   binary.LittleEndian.Uint16(ev[18:20]),
				Value:  int32(binary.LittleEndian.Uint32(ev[20:24])),
				TimeMS: sec*1000 + usec/1000,
			}
		} else {
			sec := int64(int32(binary.LittleEndian.Uint32(ev[0:4])))
			usec := int64(int32(binary.LittleEndian.Uint32(ev[4:8])))
			e = pen.Event{
				Type:   binary.LittleEndian.Uint16(ev[8:10]),
				Code:   binary.LittleEndian.Uint16(ev[10:12]),
				Value:  int32(binary.LittleEndian.Uint32(ev[12:16])),
				TimeMS: sec*1000 + usec/1000,
			}
		}
		cb(e)
	}
	// keep a partial event for the next read, detached from the caller's reused buffer
	p.buf = append([]byte(nil), p.buf...)
}


