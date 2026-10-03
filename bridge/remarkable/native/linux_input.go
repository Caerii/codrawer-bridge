package main

// Linux evdev plumbing: the input_event wire struct and the three ioctls the bridge needs.
//
// Every /dev/input/eventN read returns whole struct input_event records:
//
//	struct timeval time (sec, usec: two longs) · u16 type · u16 code · s32 value
//
// which is 24 bytes where long is 64-bit (the Paper Pro is aarch64) and 16 bytes on 32-bit
// platforms. The event codes themselves are package pen's constants, so the device code and the
// state machine share one vocabulary.

import (
	"encoding/binary"
	"unsafe"

	"golang.org/x/sys/unix"

	"codrawer-bridge-native/pen"
)

// absInfo mirrors struct input_absinfo (EVIOCGABS): the axis's current value and its range, in
// device units.
type absInfo struct {
	Value      int32
	Min        int32
	Max        int32
	Fuzz       int32
	Flat       int32
	Resolution int32
}

// ── ioctls ──────────────────────────────────────────────────────────────────

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

// evioCGAbs is EVIOCGABS(abs) = _IOR('E', 0x40 + abs, struct input_absinfo).
func evioCGAbs(absCode int) uintptr {
	return ioc(iocRead, uint32('E'), uint32(0x40+absCode), uint32(unsafe.Sizeof(absInfo{})))
}

// evioCGrab is EVIOCGRAB = _IOW('E', 0x90, int).
func evioCGrab() uintptr {
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

// getRanges reads the pen's x, y and pressure ranges. An axis that cannot be read keeps a
// placeholder range (0..1 for x and y, 0..4096 for pressure).
func getRanges(fd int) pen.Ranges {
	x, errX := getAbsInfo(fd, pen.AbsX)
	y, errY := getAbsInfo(fd, pen.AbsY)
	p, errP := getAbsInfo(fd, pen.AbsPressure)
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

// tryGrab makes this process the device's only reader (EVIOCGRAB); failures are ignored. Grabbing
// the pen stops xochitl from drawing, which is why NO_GRAB is the default.
func tryGrab(fd int) {
	var one int32 = 1
	_, _, _ = unix.Syscall(unix.SYS_IOCTL, uintptr(fd), evioCGrab(), uintptr(unsafe.Pointer(&one)))
}

// ── input_event parsing ─────────────────────────────────────────────────────

// inputParser parses input_event records from a stream of reads, carrying a partial record over
// to the next read. The zero value is ready.
type inputParser struct {
	buf []byte
	sz  int // record size: 0 until the first feed, then 16 or 24
}

// feed parses every whole record in chunk (after any partial one held from the previous feed)
// and calls cb with each, timestamp in Unix ms. The record size follows the platform's timeval:
// 24 bytes where long is 64-bit, else 16. (An older guess from the first read's length misread
// 48-byte reads of 16-byte events.) chunk may be reused by the caller after feed returns.
func (p *inputParser) feed(chunk []byte, cb func(ev pen.Event)) {
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
		rec := p.buf[:p.sz]
		p.buf = p.buf[p.sz:]
		cb(decodeEvent(rec))
	}
	// keep a partial event for the next read, detached from the caller's reused buffer
	p.buf = append([]byte(nil), p.buf...)
}

// decodeEvent decodes one little-endian input_event record of 24 or 16 bytes.
func decodeEvent(rec []byte) pen.Event {
	if len(rec) == 24 {
		sec := int64(binary.LittleEndian.Uint64(rec[0:8]))
		usec := int64(binary.LittleEndian.Uint64(rec[8:16]))
		return pen.Event{
			Type:   binary.LittleEndian.Uint16(rec[16:18]),
			Code:   binary.LittleEndian.Uint16(rec[18:20]),
			Value:  int32(binary.LittleEndian.Uint32(rec[20:24])),
			TimeMS: sec*1000 + usec/1000,
		}
	}
	sec := int64(int32(binary.LittleEndian.Uint32(rec[0:4])))
	usec := int64(int32(binary.LittleEndian.Uint32(rec[4:8])))
	return pen.Event{
		Type:   binary.LittleEndian.Uint16(rec[8:10]),
		Code:   binary.LittleEndian.Uint16(rec[10:12]),
		Value:  int32(binary.LittleEndian.Uint32(rec[12:16])),
		TimeMS: sec*1000 + usec/1000,
	}
}
