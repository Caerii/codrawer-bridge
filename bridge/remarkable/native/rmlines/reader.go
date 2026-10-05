package rmlines

// The tagged-value reader.
//
// Block bodies are sequences of tagged values. A tag is a varuint whose low nibble is the value's
// type and whose remaining bits are the field index within the block:
//
//	tag = index<<4 | type
//
// The reader works inside a limit (end): the current block or subblock. Reading past it is
// ErrTruncated, never a read into the next block, so a malformed block cannot corrupt its
// neighbours. sub narrows the limit to a subblock and afterwards jumps to the subblock's end,
// which is how fields added by newer firmware are skipped without knowing them.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Tag types (the low nibble of a tag).
const (
	tagID      = 0xF // a CRDT id: u8 author, varuint counter
	tagLength4 = 0xC // a subblock: u32 length, then that many bytes
	tagByte8   = 0x8 // 8 bytes (f64)
	tagByte4   = 0x4 // 4 bytes (u32 or f32)
	tagByte1   = 0x1 // 1 byte (bool)
)

// errTag means a field was not the one expected at this position (a different layout).
var errTag = errors.New("rmlines: unexpected tag")

// reader reads little-endian values from b, starting at pos and never past end.
type reader struct {
	b   []byte
	pos int
	end int // current block/subblock limit
}

// ── raw values ──────────────────────────────────────────────────────────────

func (r *reader) need(n int) error {
	if n < 0 || r.pos+n > r.end {
		return ErrTruncated
	}
	return nil
}

func (r *reader) u8() (uint8, error) {
	if err := r.need(1); err != nil {
		return 0, err
	}
	v := r.b[r.pos]
	r.pos++
	return v, nil
}

func (r *reader) u16() (uint16, error) {
	if err := r.need(2); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint16(r.b[r.pos:])
	r.pos += 2
	return v, nil
}

func (r *reader) u32() (uint32, error) {
	if err := r.need(4); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint32(r.b[r.pos:])
	r.pos += 4
	return v, nil
}

func (r *reader) f32() (float32, error) {
	v, err := r.u32()
	return math.Float32frombits(v), err
}

func (r *reader) f64() (float64, error) {
	if err := r.need(8); err != nil {
		return 0, err
	}
	v := binary.LittleEndian.Uint64(r.b[r.pos:])
	r.pos += 8
	return math.Float64frombits(v), nil
}

// varuint reads an unsigned LEB128 number (7 bits per byte, high bit = more).
func (r *reader) varuint() (uint64, error) {
	var v uint64
	for shift := 0; shift < 64; shift += 7 {
		c, err := r.u8()
		if err != nil {
			return 0, err
		}
		v |= uint64(c&0x7f) << shift
		if c&0x80 == 0 {
			return v, nil
		}
	}
	return 0, errors.New("rmlines: varuint overflow")
}

func (r *reader) crdt() (CrdtID, error) {
	a, err := r.u8()
	if err != nil {
		return CrdtID{}, err
	}
	c, err := r.varuint()
	return CrdtID{a, c}, err
}

// ── tags ────────────────────────────────────────────────────────────────────

// peekTag reports whether the next tag is (index, typ) without consuming it. Optional fields are
// read only when their tag is next.
func (r *reader) peekTag(index int, typ uint8) bool {
	if r.pos >= r.end {
		return false
	}
	save := r.pos
	defer func() { r.pos = save }()
	x, err := r.varuint()
	return err == nil && x>>4 == uint64(index) && uint8(x&0xF) == typ
}

// tag consumes the next tag, which must be (index, typ); on a mismatch it consumes nothing and
// returns an error wrapping errTag.
func (r *reader) tag(index int, typ uint8) error {
	save := r.pos
	x, err := r.varuint()
	if err != nil {
		return err
	}
	if x>>4 != uint64(index) || uint8(x&0xF) != typ {
		r.pos = save
		return fmt.Errorf("%w: want %d/%#x, got %d/%#x at %d", errTag, index, typ, x>>4, x&0xF, save)
	}
	return nil
}

// ── tagged values ───────────────────────────────────────────────────────────

func (r *reader) id(index int) (CrdtID, error) {
	if err := r.tag(index, tagID); err != nil {
		return CrdtID{}, err
	}
	return r.crdt()
}

func (r *reader) tInt(index int) (uint32, error) {
	if err := r.tag(index, tagByte4); err != nil {
		return 0, err
	}
	return r.u32()
}

func (r *reader) tFloat(index int) (float32, error) {
	if err := r.tag(index, tagByte4); err != nil {
		return 0, err
	}
	return r.f32()
}

func (r *reader) tDouble(index int) (float64, error) {
	if err := r.tag(index, tagByte8); err != nil {
		return 0, err
	}
	return r.f64()
}

func (r *reader) tBool(index int) (bool, error) {
	if err := r.tag(index, tagByte1); err != nil {
		return false, err
	}
	v, err := r.u8()
	return v != 0, err
}

// ── subblocks ───────────────────────────────────────────────────────────────

// sub reads a subblock header and runs fn with the limit set to the subblock; whatever fn did
// not read (newer fields) is skipped. The outer limit is restored even when fn fails.
func (r *reader) sub(index int, fn func() error) error {
	if err := r.tag(index, tagLength4); err != nil {
		return err
	}
	n, err := r.u32()
	if err != nil {
		return err
	}
	if err := r.need(int(n)); err != nil {
		return err
	}
	outer, end := r.end, r.pos+int(n)
	r.end = end
	err = fn()
	r.pos, r.end = end, outer
	return err
}

// hasSub reports whether a subblock with this index is next.
func (r *reader) hasSub(index int) bool { return r.peekTag(index, tagLength4) }
