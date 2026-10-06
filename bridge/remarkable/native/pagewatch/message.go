package pagewatch

// The `page` message (docs/protocol.md, "page").
//
// One message is the whole saved page, so it is built by hand into one growing buffer rather
// than through encoding/json: a dense page has hundreds of thousands of numbers, and the wire
// size matters (about 3.7 bytes of JSON per byte of `.rm`; a 45-stroke calligraphy page is
// 169 KB). Numbers are rounded to what a renderer can use and written in their shortest form.

import (
	"encoding/json"
	"math"
	"strconv"

	"codrawer-bridge-native/rmlines"
)

// Page size in page units when the file has no SceneInfo (Paper Pro portrait).
const (
	defaultW = 1620
	defaultH = 2160
)

// Rounding of the numbers in a `page` message (values are rounded to 1/scale).
const (
	coordScale    = 1e5  // normalised x, y: 1e-5 of the page ≈ 0.02 px
	pressureScale = 1e3  // pressure 0..1
	widthScale    = 1e6  // width as a fraction of the page width: 1e-6 ≈ 0.002 px
	sizeScale     = 1000 // thickness_scale
)

// Message builds the `page` message for a parsed page (nil: a page with no ink saved yet).
//
// Coordinates are normalised to the paper: x_norm = (x + W/2) / W (xochitl's x is centred),
// y_norm = y / H; points on a scrolled page can fall outside 0..1 and are kept. Each point is
// [x, y, pressure 0..1, width as a fraction of the page width] (the file's width is in quarter
// pixels). Strokes on hidden layers, erased strokes and strokes with no points are left out: the
// snapshot is the page as the user sees it.
func Message(loc Location, rev int64, page *rmlines.Page) []byte {
	w, h := float64(defaultW), float64(defaultH)
	if page != nil && page.PaperW > 0 && page.PaperH > 0 {
		w, h = float64(page.PaperW), float64(page.PaperH)
	}
	b := make([]byte, 0, 4096)
	b = appendHeader(b, loc, rev, w, h)
	b = append(b, `,"strokes":[`...)
	first := true
	if page != nil {
		for _, layer := range page.Layers {
			if !layer.Visible {
				continue
			}
			agent := layer.Label == AgentLayer
			for _, l := range layer.Lines {
				if len(l.Points) == 0 {
					continue
				}
				if !first {
					b = append(b, ',')
				}
				first = false
				b = appendStroke(b, l, w, h, agent)
			}
		}
	}
	b = append(b, "]}"...)
	return b
}

// appendHeader writes everything before the strokes: type, doc, page, title (when known), rev
// and the page size in page units.
func appendHeader(b []byte, loc Location, rev int64, w, h float64) []byte {
	b = append(b, `{"t":"page","doc":`...)
	b = appendString(b, loc.Doc)
	b = append(b, `,"page":`...)
	b = appendString(b, loc.Page)
	if loc.Title != "" {
		b = append(b, `,"title":`...)
		b = appendString(b, loc.Title)
	}
	b = append(b, `,"rev":`...)
	b = strconv.AppendInt(b, rev, 10)
	b = append(b, `,"w":`...)
	b = strconv.AppendInt(b, int64(w), 10)
	b = append(b, `,"h":`...)
	b = strconv.AppendInt(b, int64(h), 10)
	return b
}

// AgentLayer is the layer the codrawer-layer extension commits agent ink to (NATIVE_AGENT_INK).
// Its strokes are agent ink that viewers already drew live from the router's `layer:"ai"`
// stream, so the snapshot labels them `"layer":"ai"` instead of the layer id: a client then
// treats them as agent ink, not as the tablet user's (docs/protocol.md, "page").
const AgentLayer = "codrawer: agent"

// appendStroke writes one stroke object: id, tool name, palette id, resolved #rrggbbaa colour,
// size, layer id (or "ai" on the agent layer) and points.
func appendStroke(b []byte, l *rmlines.Line, w, h float64, agent bool) []byte {
	c := l.RGBA()
	b = append(b, `{"id":"`...)
	b = append(b, l.ID.String()...)
	b = append(b, `","tool":"`...)
	b = append(b, rmlines.ToolName(l.Tool)...)
	b = append(b, `","color":`...)
	b = strconv.AppendInt(b, int64(l.Color), 10)
	b = append(b, `,"rgba":"#`...)
	for _, v := range []uint8{c.R, c.G, c.B, c.A} {
		b = append(b, hexDigit[v>>4], hexDigit[v&15])
	}
	b = append(b, `","size":`...)
	b = appendNum(b, l.ThicknessScale, sizeScale)
	if agent {
		b = append(b, `,"layer":"ai"`...)
	} else if l.Layer != (rmlines.CrdtID{}) {
		b = append(b, `,"layer":"`...)
		b = append(b, l.Layer.String()...)
		b = append(b, '"')
	}
	b = append(b, `,"pts":[`...)
	for i, p := range l.Points {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendPoint(b, p, w, h)
	}
	return append(b, "]}"...)
}

// appendPoint writes [x, y, p, w] normalised as described on Message.
func appendPoint(b []byte, p rmlines.Point, w, h float64) []byte {
	b = append(b, '[')
	b = appendNum(b, (float64(p.X)+w/2)/w, coordScale)
	b = append(b, ',')
	b = appendNum(b, float64(p.Y)/h, coordScale)
	b = append(b, ',')
	b = appendNum(b, float64(p.Pressure)/255, pressureScale)
	b = append(b, ',')
	b = appendNum(b, float64(p.Width)/4/w, widthScale)
	return append(b, ']')
}

const hexDigit = "0123456789abcdef"

// appendNum writes v rounded to 1/scale, shortest form (0.5, 0.12345). NaN and ±Inf, which JSON
// cannot carry, become 0.
func appendNum(b []byte, v, scale float64) []byte {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return append(b, '0')
	}
	r := math.Round(v*scale) / scale
	if r == 0 {
		r = 0 // no "-0"
	}
	return strconv.AppendFloat(b, r, 'f', -1, 64)
}

// appendString writes s as a JSON string (titles are user text).
func appendString(b []byte, s string) []byte {
	q, _ := json.Marshal(s)
	return append(b, q...)
}
