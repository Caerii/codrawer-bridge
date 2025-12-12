package main

// Linux input plumbing:
// - constants for event codes we care about
// - ioctl helpers to read ABS axis ranges and optionally EVIOCGRAB
// - parsing input_event stream (16B vs 24B timeval size)

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/unix"
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

type absRanges struct {
	xMin, xMax int32
	yMin, yMax int32
	pMin, pMax int32
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

func getRanges(fd int) absRanges {
	x, errX := getAbsInfo(fd, ABS_X)
	y, errY := getAbsInfo(fd, ABS_Y)
	p, errP := getAbsInfo(fd, ABS_PRESSURE)
	r := absRanges{xMin: 0, xMax: 1, yMin: 0, yMax: 1, pMin: 0, pMax: 4096}
	if errX == nil {
		r.xMin, r.xMax = x.Min, x.Max
	}
	if errY == nil {
		r.yMin, r.yMax = y.Min, y.Max
	}
	if errP == nil {
		r.pMin, r.pMax = p.Min, p.Max
	}
	return r
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
	p.buf = append(p.buf, chunk...)
	if p.sz == 0 {
		if len(p.buf) >= 48 && len(p.buf)%24 == 0 {
			p.sz = 24
		} else if len(p.buf) >= 32 && len(p.buf)%16 == 0 {
			p.sz = 16
		} else if len(p.buf) >= 24 {
			// fallback: assume 24 on 64-bit devices (Paper Pro likely aarch64)
			p.sz = 24
		}
	}
	for p.sz != 0 && len(p.buf) >= p.sz {
		ev := p.buf[:p.sz]
		p.buf = p.buf[p.sz:]
		var etype, code uint16
		var value int32
		if p.sz == 24 {
			etype = binary.LittleEndian.Uint16(ev[16:18])
			code = binary.LittleEndian.Uint16(ev[18:20])
			value = int32(binary.LittleEndian.Uint32(ev[20:24]))
		} else {
			etype = binary.LittleEndian.Uint16(ev[8:10])
			code = binary.LittleEndian.Uint16(ev[10:12])
			value = int32(binary.LittleEndian.Uint32(ev[12:16]))
		}
		cb(etype, code, value)
	}
}


