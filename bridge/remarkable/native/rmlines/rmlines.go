// Package rmlines reads reMarkable v6 `.rm` page files ("reMarkable .lines file, version=6")
// into strokes. It is read-only, portable (no OS-specific imports) and follows the format as
// documented by rmscene (github.com/ricklupton/rmscene, MIT), which is the reference this
// package is cross-checked against (testdata/README.md).
//
// A file is a 43-byte header followed by blocks: u32 length, u8 0, u8 min version, u8 current
// version, u8 type, then a body of tagged values (varuint tag = index<<4 | type). Strokes are
// SceneLineItemBlocks: items of a CRDT sequence whose parent is a layer (a group node). An
// erased or undone stroke stays in the file as an item without a value (deleted_length > 0) or
// as a tombstone block; both are reported in Page.Deleted and never as a live Line.
//
// Unknown blocks, unknown trailing fields in a block or subblock (newer firmware) and blocks
// that fail to parse are skipped by their length, so a newer xochitl degrades to "fewer
// fields", not to an error. A file that is truncated (a block runs past the end, e.g. read
// while xochitl is writing it) is an error: the caller should retry later.
package rmlines

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"sort"
)

// Header is the first 43 bytes of every v6 file.
const Header = "reMarkable .lines file, version=6          "

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

// Tag types.
const (
	tagID      = 0xF
	tagLength4 = 0xC
	tagByte8   = 0x8
	tagByte4   = 0x4
	tagByte1   = 0x1
)

// ErrTruncated means the file ends inside a block (most likely it is being written).
var ErrTruncated = errors.New("rmlines: truncated file")

// ErrHeader means the file is not a v6 .rm file.
var ErrHeader = errors.New("rmlines: not a reMarkable v6 lines file")

// CrdtID identifies an item (author, counter). Author 0 is the document itself.
type CrdtID struct {
	Author  uint8
	Counter uint64
}

func (c CrdtID) String() string { return fmt.Sprintf("%d:%d", c.Author, c.Counter) }

// IsZero reports the end marker (0:0).
func (c CrdtID) IsZero() bool { return c.Author == 0 && c.Counter == 0 }

// RootID is the scene tree's root group; its children are the layers.
var RootID = CrdtID{0, 1}

// Point is one sample as xochitl stored it. For version-2 points (all current firmware) the
// values are the stored integers: Speed and Width are in quarter units (Width/4 = stroke width
// in page pixels), Direction 0..255 is a full turn, Pressure 0..255. Version-1 points (old
// firmware, six floats) are converted the way rmscene does.
type Point struct {
	X, Y      float32
	Speed     float32
	Direction float32
	Width     float32
	Pressure  float32
}

// RGBA is a colour, components 0..255.
type RGBA struct{ R, G, B, A uint8 }

// Line is one live stroke.
type Line struct {
	ID    CrdtID
	Layer CrdtID // the top-level group (layer) it belongs to
	// Tool is xochitl's pen id (see ToolName), Color its palette id (see PaletteRGBA).
	Tool  int
	Color int
	// ColorRGBA is the explicit colour (Paper Pro highlighter and shader, colour id 9), or nil.
	ColorRGBA      *RGBA
	ThicknessScale float64 // the size setting (1, 2, 3 or a fraction for pressure-sized tools)
	StartingLength float32
	Points         []Point
	MoveID         *CrdtID // set when the stroke was moved with the selection tool
}

// Layer is a top-level group of the page.
type Layer struct {
	ID      CrdtID
	Label   string
	Visible bool
	Lines   []*Line // live strokes in drawing (CRDT) order
}

// Page is a parsed .rm file.
type Page struct {
	Layers []*Layer
	// Deleted lists strokes erased or undone (CRDT tombstones), in file order.
	Deleted []CrdtID
	// PaperW/PaperH is SceneInfo's paper size when present (1620×2160 on the Paper Pro).
	PaperW, PaperH int
	// Skipped counts blocks that were unknown or failed to parse (skipped by length).
	Skipped int
}

// Lines returns every live stroke, layer by layer, in drawing order.
func (p *Page) Lines() []*Line {
	var out []*Line
	for _, l := range p.Layers {
		out = append(out, l.Lines...)
	}
	return out
}

// ── reader ──────────────────────────────────────────────────────────────────

var errTag = errors.New("rmlines: unexpected tag")

type reader struct {
	b   []byte
	pos int
	end int // current block/subblock limit
}

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

// peekTag reports whether the next tag is (index, typ) without consuming it.
func (r *reader) peekTag(index int, typ uint8) bool {
	if r.pos >= r.end {
		return false
	}
	save := r.pos
	defer func() { r.pos = save }()
	x, err := r.varuint()
	return err == nil && x>>4 == uint64(index) && uint8(x&0xF) == typ
}

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

// sub reads a subblock header and runs fn with the limit set to the subblock; whatever fn did
// not read (newer fields) is skipped.
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

func (r *reader) hasSub(index int) bool { return r.peekTag(index, tagLength4) }

// ── parse ───────────────────────────────────────────────────────────────────

// item is any CRDT sequence item (line, group, glyph, text, tombstone); all of them take part
// in ordering their siblings even when only lines and groups are kept.
type item struct {
	id, left, right CrdtID
	parent          CrdtID
	deleted         bool
	typ             uint8
	line            *Line   // a live line
	group           *CrdtID // a live group item: the node it points at
}

type node struct {
	label   string
	visible bool
	labelTS CrdtID
}

// Parse reads a whole .rm file.
func Parse(data []byte) (*Page, error) {
	if len(data) < len(Header) || string(data[:len(Header)]) != Header {
		return nil, ErrHeader
	}
	r := &reader{b: data, pos: len(Header), end: len(data)}
	page := &Page{}
	nodes := map[CrdtID]*node{}
	var items []*item
	for r.pos < len(data) {
		r.end = len(data)
		n, err := r.u32()
		if err != nil {
			return nil, err
		}
		var hdr [4]byte
		for i := range hdr {
			if hdr[i], err = r.u8(); err != nil {
				return nil, err
			}
		}
		version, typ := hdr[2], hdr[3]
		if err := r.need(int(n)); err != nil {
			return nil, err
		}
		end := r.pos + int(n)
		r.end = end
		var perr error
		switch typ {
		case blockLineItem, blockGroupItem, blockGlyphItem, blockTextItem, blockTombstoneItem:
			var it *item
			it, perr = readItem(r, typ, version)
			if perr == nil {
				items = append(items, it)
			}
		case blockSceneTree:
			var id CrdtID
			if id, perr = r.id(1); perr == nil {
				if _, ok := nodes[id]; !ok {
					nodes[id] = &node{visible: true}
				}
			}
		case blockTreeNode:
			perr = readTreeNode(r, nodes)
		case blockSceneInfo:
			readSceneInfo(r, page)
		case blockMigrationInfo, blockRootText, blockAuthorIDs, blockPageInfo:
			// not needed for strokes
		default:
			page.Skipped++
		}
		if perr != nil {
			page.Skipped++ // malformed or newer layout: skip the block by its length
		}
		r.pos = end
	}
	build(page, nodes, items)
	return page, nil
}

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
			if kind != 0x03 {
				return fmt.Errorf("rmlines: line item type %d", kind)
			}
			l, err := readLine(r, version)
			if err != nil {
				return err
			}
			l.ID = it.id
			it.line = l
		case blockGroupItem:
			if kind != 0x02 {
				return fmt.Errorf("rmlines: group item type %d", kind)
			}
			g, err := r.id(2)
			if err != nil {
				return err
			}
			it.group = &g
		}
		return nil // glyph/text values are not needed
	})
	return it, err
}

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
	size := 0x0E
	if version == 1 {
		size = 0x18
	} else if version != 2 {
		return nil, fmt.Errorf("rmlines: line version %d", version)
	}
	err = r.sub(5, func() error {
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
	})
	if err != nil {
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

// readTreeNode reads a group's label and visibility (last-write-wins values).
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

// readSceneInfo reads the paper size if present; failures leave it zero.
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

// ── tree ────────────────────────────────────────────────────────────────────

// build orders every group's children (CRDT sequence) and walks the tree from the root:
// top-level groups are layers, nested groups are flattened into their layer.
func build(page *Page, nodes map[CrdtID]*node, items []*item) {
	children := map[CrdtID][]*item{}
	seen := map[CrdtID]bool{}
	for _, it := range items {
		if it.line == nil && it.group == nil && (it.typ == blockTombstoneItem || (it.typ == blockLineItem && it.deleted)) {
			page.Deleted = append(page.Deleted, it.id)
		}
		if seen[it.id] {
			continue // a later block for the same id (rare); keep the first for ordering
		}
		seen[it.id] = true
		children[it.parent] = append(children[it.parent], it)
	}
	var walk func(parent CrdtID, layer *Layer, depth int)
	walk = func(parent CrdtID, layer *Layer, depth int) {
		if depth > 32 {
			return
		}
		for _, it := range orderItems(children[parent]) {
			switch {
			case it.line != nil && layer != nil:
				it.line.Layer = layer.ID
				layer.Lines = append(layer.Lines, it.line)
			case it.group != nil:
				if layer == nil {
					n := nodes[*it.group]
					l := &Layer{ID: *it.group, Visible: true}
					if n != nil {
						l.Label, l.Visible = n.label, n.visible
					}
					page.Layers = append(page.Layers, l)
					walk(*it.group, l, depth+1)
				} else {
					walk(*it.group, layer, depth+1)
				}
			}
		}
	}
	walk(RootID, nil, 0)
	// Lines under a node that is not reachable from the root (should not happen): keep them in
	// a layer of their own rather than lose ink.
	reached := map[CrdtID]bool{}
	for _, l := range page.Layers {
		for _, ln := range l.Lines {
			reached[ln.ID] = true
		}
	}
	var orphanParents []CrdtID
	for p, its := range children {
		for _, it := range its {
			if it.line != nil && !reached[it.id] {
				orphanParents = append(orphanParents, p)
				break
			}
		}
	}
	sort.Slice(orphanParents, func(i, j int) bool { return less(orphanParents[i], orphanParents[j]) })
	for _, p := range orphanParents {
		l := &Layer{ID: p, Visible: true}
		for _, it := range orderItems(children[p]) {
			if it.line != nil && !reached[it.id] {
				it.line.Layer = p
				l.Lines = append(l.Lines, it.line)
			}
		}
		page.Layers = append(page.Layers, l)
	}
}

func less(a, b CrdtID) bool {
	if a.Author != b.Author {
		return a.Author < b.Author
	}
	return a.Counter < b.Counter
}

// orderItems sorts a CRDT sequence by its left/right links: Kahn's algorithm with rmscene's
// tie-break (concurrent inserts: higher author first, then lower counter), so the drawing
// order matches rmscene's exactly.
func orderItems(its []*item) []*item {
	if len(its) <= 1 {
		return its
	}
	byID := make(map[CrdtID]*item, len(its))
	for _, it := range its {
		byID[it.id] = it
	}
	// graph nodes: index 0 = start, 1 = end, 2+i = its[i]
	idx := make(map[CrdtID]int, len(its))
	for i, it := range its {
		idx[it.id] = i + 2
	}
	n := len(its) + 2
	indeg := make([]int, n)
	deps := make([][]int, n)
	side := func(id CrdtID, isLeft bool) int {
		if j, ok := idx[id]; ok && !id.IsZero() {
			return j
		}
		if isLeft {
			return 0
		}
		return 1
	}
	for i, it := range its {
		me := i + 2
		l, r := side(it.left, true), side(it.right, false)
		indeg[me]++
		deps[l] = append(deps[l], me)
		indeg[r]++
		deps[me] = append(deps[me], r)
	}
	key := func(j int) (int, int, uint64) {
		switch j {
		case 0:
			return 0, 0, 0
		case 1:
			return 2, 0, 0
		}
		id := its[j-2].id
		return 1, -int(id.Author), id.Counter
	}
	lessIdx := func(a, b int) bool {
		a0, a1, a2 := key(a)
		b0, b1, b2 := key(b)
		if a0 != b0 {
			return a0 < b0
		}
		if a1 != b1 {
			return a1 < b1
		}
		return a2 < b2
	}
	h := &intHeap{less: lessIdx}
	for j := 0; j < n; j++ {
		if indeg[j] == 0 {
			h.push(j)
		}
	}
	out := make([]*item, 0, len(its))
	done := make([]bool, n)
	for h.len() > 0 {
		j := h.pop()
		done[j] = true
		if j >= 2 {
			out = append(out, its[j-2])
		}
		if j == 1 {
			break
		}
		for _, d := range deps[j] {
			indeg[d]--
			if indeg[d] == 0 {
				h.push(d)
			}
		}
	}
	if len(out) < len(its) {
		// a cycle or items after the end marker: append the rest in id order, never lose ink
		var rest []*item
		for j := 2; j < n; j++ {
			if !done[j] {
				rest = append(rest, its[j-2])
			}
		}
		sort.Slice(rest, func(a, b int) bool { return less(rest[a].id, rest[b].id) })
		out = append(out, rest...)
	}
	return out
}

type intHeap struct {
	a    []int
	less func(a, b int) bool
}

func (h *intHeap) len() int { return len(h.a) }

func (h *intHeap) push(x int) {
	h.a = append(h.a, x)
	i := len(h.a) - 1
	for i > 0 {
		p := (i - 1) / 2
		if !h.less(h.a[i], h.a[p]) {
			break
		}
		h.a[i], h.a[p] = h.a[p], h.a[i]
		i = p
	}
}

func (h *intHeap) pop() int {
	top := h.a[0]
	last := len(h.a) - 1
	h.a[0] = h.a[last]
	h.a = h.a[:last]
	i := 0
	for {
		l, r, m := 2*i+1, 2*i+2, i
		if l < len(h.a) && h.less(h.a[l], h.a[m]) {
			m = l
		}
		if r < len(h.a) && h.less(h.a[r], h.a[m]) {
			m = r
		}
		if m == i {
			return top
		}
		h.a[i], h.a[m] = h.a[m], h.a[i]
		i = m
	}
}
