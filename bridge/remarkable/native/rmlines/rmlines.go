// Package rmlines reads reMarkable v6 `.rm` page files ("reMarkable .lines file, version=6")
// into strokes.
//
// # Why it exists
//
// xochitl, the tablet's notebook app, saves every page as one `.rm` file. That file is the only
// place where the exact tool, palette colour, explicit RGBA (Paper Pro highlighter and shader),
// size setting and per-point width of every stroke are recorded; the evdev pen stream knows none
// of them (docs/investigations/xochitl-pen-data.md §1). Package pagewatch turns a parsed page into
// the `page` message (docs/protocol.md, ADR 008), so the tablet's saved page becomes the source
// of truth that live strokes are reconciled against.
//
// The package is read-only, portable (no OS-specific imports, no dependencies) and follows the
// format as documented by rmscene (github.com/ricklupton/rmscene, MIT), the reference it is
// cross-checked against stroke for stroke (testdata/README.md, TestMatchesRmscene). We did not
// adopt go-rmscene: it needs Go 1.26, builds no scene tree (so no CRDT order and no layers) and
// finds the Paper Pro colour by byte search (xochitl-pen-data.md, "Built").
//
// # The format in one page
//
// A file is the 43-byte Header followed by blocks. Every block starts with
//
//	u32 length · u8 0 · u8 min version · u8 current version · u8 type
//
// and a body of tagged values: a varuint tag (index<<4 | type) and then the value, where the
// type says how to read it (a CRDT id, a 1/4/8-byte number, or a length-prefixed subblock). The
// reader in reader.go knows the tags; parse.go knows the blocks.
//
// The page is a tree of CRDT sequences. Group items build the tree (the root's children are the
// layers); line items are the strokes, each a child of a group. Every item names its left and
// right neighbours at insertion time, and the drawing order is recovered by sorting each
// sequence by those links (tree.go). An erased or undone stroke stays in the file, either as an
// item with no value (deleted_length > 0) or as a tombstone block; both are reported in
// Page.Deleted and never as a live Line.
//
// # Failure model
//
// Unknown blocks, unknown trailing fields in a block or subblock (newer firmware) and blocks that
// fail to parse are skipped by their length and counted in Page.Skipped, so a newer xochitl
// degrades to "fewer fields", not to an error. A truncated file (a block runs past the end, most
// likely because xochitl is writing it as we read) is ErrTruncated: the caller retries later.
//
// # Reading order
//
// rmlines.go (this file: the data model) → reader.go (tagged values) → parse.go (blocks, items,
// lines, points) → tree.go (layers and CRDT order) → tools.go (tool and colour vocabularies).
package rmlines

import (
	"errors"
	"fmt"
)

// Header is the first 43 bytes of every v6 file: the magic string padded with spaces.
const Header = "reMarkable .lines file, version=6          "

// ErrTruncated means the file ends inside a block (most likely it is being written).
var ErrTruncated = errors.New("rmlines: truncated file")

// ErrHeader means the file is not a v6 .rm file.
var ErrHeader = errors.New("rmlines: not a reMarkable v6 lines file")

// CrdtID identifies an item in xochitl's CRDT: the author (a small per-device number; 0 is the
// document itself) and that author's counter. It is stable across saves, which is why the `page`
// message uses it as the stroke id.
type CrdtID struct {
	Author  uint8
	Counter uint64
}

// String renders the id as "author:counter", the form used on the wire.
func (c CrdtID) String() string { return fmt.Sprintf("%d:%d", c.Author, c.Counter) }

// IsZero reports the end marker (0:0), which a sequence item uses as "no neighbour".
func (c CrdtID) IsZero() bool { return c.Author == 0 && c.Counter == 0 }

// RootID is the scene tree's root group; its children are the layers.
var RootID = CrdtID{0, 1}

// Point is one pen sample as xochitl stored it, in page units: X is centred (0 is the middle of
// the page, ±810 on the Paper Pro), Y grows down from the top and can exceed the page height on a
// scrolled page (xochitl-pen-data.md §4).
//
// For version-2 points (all current firmware) the other fields are the stored integers: Speed and
// Width are in quarter units (Width/4 is the stroke width in page pixels at this point, as
// xochitl computed it), Direction 0..255 is a full turn, Pressure 0..255. Version-1 points (old
// firmware, six floats) are converted to the same units the way rmscene does.
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

// Layer is a top-level group of the page. Nested groups are flattened into their layer.
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
	// PaperW/PaperH is SceneInfo's paper size in page units when present (1620×2160 on the Paper
	// Pro), else 0.
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
