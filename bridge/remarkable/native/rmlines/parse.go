package rmlines

// Blocks, items, lines and points.
//
// Parse walks the file block by block. Each block is read inside its own limit and the reader
// then jumps to the block's end, whatever happened inside: that one rule is what makes unknown
// blocks, newer trailing fields and malformed blocks harmless. What the blocks contribute is
// collected in a scene (items, tree nodes, paper size) and turned into layers by build (tree.go)
// once every block has been seen, because a sequence item can arrive before its neighbours.

import (
	"encoding/binary"
	"fmt"
	"math"
)

// Block types (rmscene scene_stream.py).
const (
	blockMigrationInfo = 0x00
	blockSceneTree     = 0x01
	blockTreeNode      = 0x02
	blockGlyphItem     = 0x03
	blockGroupItem     = 0x04
	blockLineItem      = 0x05
	blockTextItem      = 0x06
	blockRootText      = 0x07
	blockTombstoneItem = 0x08
	blockAuthorIDs     = 0x09
	blockPageInfo      = 0x0A
	blockSceneInfo     = 0x0D
)

// Item value kinds: the first byte of an item's value subblock.
const (
	valueGroup = 0x02
	valueLine  = 0x03
)

// Point record sizes in bytes, by line block version.
const (
	pointSizeV1 = 0x18 // six f32
	pointSizeV2 = 0x0E // x f32, y f32, speed u16, width u16, direction u8, pressure u8
)

// blockHeader is the 8 bytes in front of every block.
type blockHeader struct {
	length     uint32 // body length in bytes, header excluded
	minVersion uint8  // oldest reader version that understands the body (unused here)
	version    uint8  // the body's layout version; line blocks use it for the point format
	typ        uint8  // one of the block* constants
}

// item is any CRDT sequence item (line, group, glyph, text, tombstone). All of them take part in
// ordering their siblings even though only lines and groups are kept.
type item struct {
	id, left, right CrdtID
	parent          CrdtID
	deleted         bool
	typ             uint8
	line            *Line   // a live line
	group           *CrdtID // a live group item: the node it points at
}

// node is a group's last-write-wins properties (TreeNodeBlock).
type node struct {
	label   string
	visible bool
	labelTS CrdtID
}

// scene accumulates what the blocks of one file contribute.
type scene struct {
	page  *Page
	nodes map[CrdtID]*node
	items []*item
}

// Parse reads a whole .rm file. It fails only on a wrong header or a truncated file; anything
// else it cannot read is skipped and counted in Page.Skipped.
func Parse(data []byte) (*Page, error) {
	if len(data) < len(Header) || string(data[:len(Header)]) != Header {
		return nil, ErrHeader
	}
	r := &reader{b: data, pos: len(Header), end: len(data)}
	s := &scene{page: &Page{}, nodes: map[CrdtID]*node{}}
	for r.pos < len(data) {
		r.end = len(data)
		h, err := r.blockHeader()
		if err != nil {
			return nil, err
		}
		end := r.pos + int(h.length)
		r.end = end
		if err := s.block(r, h); err != nil {
			s.page.Skipped++ // malformed or newer layout: skip the block by its length
		}
		r.pos = end
	}
	build(s.page, s.nodes, s.items)
	return s.page, nil
}

// blockHeader reads a block's header and checks that its whole body is present.
func (r *reader) blockHeader() (blockHeader, error) {
	n, err := r.u32()
	if err != nil {
		return blockHeader{}, err
	}
	var b [4]byte // 0, min version, current version, type
	for i := range b {
		if b[i], err = r.u8(); err != nil {
			return blockHeader{}, err
		}
	}
	if err := r.need(int(n)); err != nil {
		return blockHeader{}, err
	}
	return blockHeader{length: n, minVersion: b[1], version: b[2], typ: b[3]}, nil
}

// block parses one block body into the scene. An unknown block type counts as skipped here; a
// known one that fails to parse returns the error and the caller counts it.
func (s *scene) block(r *reader, h blockHeader) error {
	switch h.typ {
	case blockLineItem, blockGroupItem, blockGlyphItem, blockTextItem, blockTombstoneItem:
		it, err := readItem(r, h.typ, h.version)
		if err != nil {
			return err
		}
		s.items = append(s.items, it)
	case blockSceneTree:
		id, err := r.id(1)
		if err != nil {
			return err
		}
		if _, ok := s.nodes[id]; !ok {
			s.nodes[id] = &node{visible: true}
		}
	case blockTreeNode:
		return readTreeNode(r, s.nodes)
	case blockSceneInfo:
		readSceneInfo(r, s.page)
	case blockMigrationInfo, blockRootText, blockAuthorIDs, blockPageInfo:
		// not needed for strokes
	default:
		s.page.Skipped++
	}
	return nil
}

// ── items ───────────────────────────────────────────────────────────────────

// readItem reads a sequence item: parent, id, left and right neighbours, deleted length, and
// (when the item is live) its value subblock. Only line and group values are decoded; glyph and
// text values are skipped by the subblock's length.
func readItem(r *reader, typ, version uint8) (*item, error) {
	it := &item{typ: typ}
	var err error
	if it.parent, err = r.id(1); err != nil {
		return nil, err
	}
	if it.id, err = r.id(2); err != nil {
		return nil, err
	}
	if it.left, err = r.id(3); err != nil {
		return nil, err
	}
	if it.right, err = r.id(4); err != nil {
		return nil, err
	}
	delLen, err := r.tInt(5)
	if err != nil {
		return nil, err
	}
	if typ == blockTombstoneItem || !r.hasSub(6) {
		it.deleted = delLen > 0 || typ == blockTombstoneItem
		return it, nil
	}
	err = r.sub(6, func() error {
		kind, err := r.u8()
		if err != nil {
			return err
		}
		switch typ {
		case blockLineItem:
			if kind != valueLine {
				return fmt.Errorf("rmlines: line item type %d", kind)
			}
			l, err := readLine(r, version)
			if err != nil {
				return err
			}
			l.ID = it.id
			it.line = l
		case blockGroupItem:
			if kind != valueGroup {
				return fmt.Errorf("rmlines: group item type %d", kind)
			}
			g, err := r.id(2)
			if err != nil {
				return err
			}
			it.group = &g
		}
		return nil
	})
	return it, err
}

// ── lines and points ────────────────────────────────────────────────────────

// readLine reads a line value (rmscene line_from_stream): tool, colour, thickness scale,
// starting length, the points subblock, a timestamp id, and the optional move id (7) and
// explicit colour (8) that newer firmware appends.
func readLine(r *reader, version uint8) (*Line, error) {
	l := &Line{}
	tool, err := r.tInt(1)
	if err != nil {
		return nil, err
	}
	color, err := r.tInt(2)
	if err != nil {
		return nil, err
	}
	l.Tool, l.Color = int(tool), int(color)
	if l.ThicknessScale, err = r.tDouble(3); err != nil {
		return nil, err
	}
	if l.StartingLength, err = r.tFloat(4); err != nil {
		return nil, err
	}
	size := pointSizeV2
	if version == 1 {
		size = pointSizeV1
	} else if version != 2 {
		return nil, fmt.Errorf("rmlines: line version %d", version)
	}
	if err := r.sub(5, func() error { return readPoints(r, version, size, l) }); err != nil {
		return nil, err
	}
	if _, err := r.id(6); err != nil { // timestamp (unused)
		return nil, err
	}
	if r.end-r.pos >= 3 && r.peekTag(7, tagID) {
		m, err := r.id(7)
		if err != nil {
			return nil, err
		}
		l.MoveID = &m
	}
	if r.peekTag(8, tagByte4) {
		v, err := r.tInt(8)
		if err != nil {
			return nil, err
		}
		// stored as a little-endian u32 0xAARRGGBB (bytes B, G, R, A)
		l.ColorRGBA = &RGBA{R: uint8(v >> 16), G: uint8(v >> 8), B: uint8(v), A: uint8(v >> 24)}
	}
	return l, nil
}

// readPoints fills l.Points from the points subblock, which must hold whole records.
func readPoints(r *reader, version uint8, size int, l *Line) error {
	n := r.end - r.pos
	if n%size != 0 {
		return fmt.Errorf("rmlines: point data %d not a multiple of %d", n, size)
	}
	l.Points = make([]Point, n/size)
	for i := range l.Points {
		p, err := readPoint(r, version)
		if err != nil {
			return err
		}
		l.Points[i] = p
	}
	return nil
}

// readPoint reads one point. Version-1 floats are converted to version-2 units as rmscene does:
// speed ×4, direction radians → 0..255, width ×4 rounded (quarter pixels), pressure 0..1 → 0..255.
func readPoint(r *reader, version uint8) (Point, error) {
	var p Point
	var err error
	if p.X, err = r.f32(); err != nil {
		return p, err
	}
	if p.Y, err = r.f32(); err != nil {
		return p, err
	}
	if version == 1 {
		var s, d, w, pr float32
		for _, f := range []*float32{&s, &d, &w, &pr} {
			if *f, err = r.f32(); err != nil {
				return p, err
			}
		}
		p.Speed = s * 4
		p.Direction = float32(255 * float64(d) / (2 * math.Pi))
		p.Width = float32(math.Round(float64(w) * 4))
		p.Pressure = pr * 255
		return p, nil
	}
	s, err := r.u16()
	if err != nil {
		return p, err
	}
	w, err := r.u16()
	if err != nil {
		return p, err
	}
	d, err := r.u8()
	if err != nil {
		return p, err
	}
	pr, err := r.u8()
	if err != nil {
		return p, err
	}
	p.Speed, p.Width, p.Direction, p.Pressure = float32(s), float32(w), float32(d), float32(pr)
	return p, nil
}

// ── tree nodes and scene info ───────────────────────────────────────────────

// readTreeNode reads a group's label and visibility (last-write-wins values). A node seen here
// before any SceneTree block names it is created visible.
func readTreeNode(r *reader, nodes map[CrdtID]*node) error {
	id, err := r.id(1)
	if err != nil {
		return err
	}
	n := nodes[id]
	if n == nil {
		n = &node{visible: true}
		nodes[id] = n
	}
	err = r.sub(2, func() error {
		ts, err := r.id(1)
		if err != nil {
			return err
		}
		return r.sub(2, func() error {
			ln, err := r.varuint()
			if err != nil {
				return err
			}
			if _, err := r.u8(); err != nil { // is_ascii
				return err
			}
			if err := r.need(int(ln)); err != nil {
				return err
			}
			n.label, n.labelTS = string(r.b[r.pos:r.pos+int(ln)]), ts
			r.pos += int(ln)
			return nil
		})
	})
	if err != nil {
		return err
	}
	return r.sub(3, func() error {
		if _, err := r.id(1); err != nil {
			return err
		}
		v, err := r.tBool(2)
		n.visible = v
		return err
	})
}

// readSceneInfo reads the paper size (field 5, two u32) if present. Its other fields vary by
// firmware, so it walks every tag generically; any failure just leaves the size zero.
func readSceneInfo(r *reader, page *Page) {
	for r.pos < r.end {
		x, err := r.varuint()
		if err != nil {
			return
		}
		index, typ := x>>4, uint8(x&0xF)
		switch typ {
		case tagLength4:
			n, err := r.u32()
			if err != nil || r.need(int(n)) != nil {
				return
			}
			if index == 5 && n >= 8 {
				page.PaperW = int(binary.LittleEndian.Uint32(r.b[r.pos:]))
				page.PaperH = int(binary.LittleEndian.Uint32(r.b[r.pos+4:]))
			}
			r.pos += int(n)
		case tagByte1:
			r.pos++
		case tagByte4:
			r.pos += 4
		case tagByte8:
			r.pos += 8
		case tagID:
			if _, err := r.crdt(); err != nil {
				return
			}
		default:
			return
		}
	}
}
