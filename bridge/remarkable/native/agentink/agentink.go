// Package agentink turns agent ink from the router into native xochitl strokes.
//
// # The problem
//
// An agent (the router's AI worker, a Claude Code session, the handwriting simulator) draws by
// sending `stroke_begin`/`stroke_pts`/`stroke_end` on `layer:"ai"` (docs/protocol.md). Viewers
// show that ink; the tablet did not, because xochitl draws only what its own pen produced. The
// codrawer-layer XOVI extension now commits strokes into xochitl's scene through xochitl's own
// pen-commit path (`SceneController.addDrawingLine`, Probe 1 in
// docs/investigations/native-multiplayer-layer.md: it renders, saves into the notebook, and
// undoes). It listens on a Unix socket, /run/codrawer/ink.sock. This package is the bridge's half:
// it follows the router's ai-layer strokes and, when one ends, produces one socket line for it.
//
// # Governance (ADR 003)
//
//   - Only `layer:"ai"` strokes are forwarded; user and peer ink never are. The extension writes
//     them only to its own layer, "codrawer: agent", never to a user layer, and only on the page
//     on screen (it refuses any other page).
//   - Size caps: at most MaxOpen strokes in progress, MaxPoints points per stroke (a stroke over
//     it is dropped whole, not truncated), and points must lie on or near the page.
//   - A rate cap: a token bucket of Burst strokes refilled at PerSecond strokes per second. A
//     stroke over the cap is dropped and counted, so a runaway agent cannot fill a notebook.
//
// # Timing: replies write themselves in
//
// A stroke is committed when its `stroke_end` arrives, so strokes appear on the page one by one
// at the pace the agent sends them. The handwriting simulator streams a reply at writing speed,
// so it writes itself in. (Within a stroke there is no animation: xochitl commits a line whole.)
//
// # Coordinates
//
// The protocol's points are normalised to the page, [x, y, p] or [x, y, p, t]: x = (x_rm + w/2)/w,
// y = y_rm/h (the `page` message's rule). The extension wants page coordinates (xochitl's scene
// units: x centred, −w/2..w/2; y down from the top), so x_rm = x·w − w/2 and y_rm = y·h, with w, h
// from the latest `page` snapshot (1620 × 2160 by default). Each point's width is
// 2 × thickness px, the fineliner's width at that size; pressure passes through.
//
// The package does no I/O: Handle takes a router message and returns the socket lines to send.
// It is not safe for concurrent use.
package agentink

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Default caps; the zero values of Forwarder's fields mean these.
const (
	DefaultMaxOpen   = 32
	DefaultMaxPoints = 4000
	DefaultBurst     = 40
	DefaultPerSecond = 15.0
	// DefaultARGB is agent ink's colour when a stroke names none: a clear blue, distinct from the
	// user's black ink and close to the viewers' ai blue.
	DefaultARGB = 0xff1f6fe0
)

// Page is what the conversion needs from the latest `page` snapshot.
type Page struct {
	Doc, Page string
	W, H      float64 // page units; 0 means 1620 × 2160
}

// Forwarder follows ai-layer strokes. Zero values of the caps mean the defaults above.
type Forwarder struct {
	MaxOpen   int
	MaxPoints int
	Burst     int
	PerSecond float64
	Now       func() time.Time // clock for the rate cap (tests replace it)

	open    map[string]*stroke
	tokens  float64
	refill  time.Time
	started bool

	// Counters, for the log.
	Sent, DroppedRate, DroppedSize, DroppedNoPage int
}

type stroke struct {
	brush, color string
	size         float64
	pts          [][]float64
	tooMany      bool
}

// message is the part of a router message this package reads.
type message struct {
	T     string            `json:"t"`
	ID    string            `json:"id"`
	Layer string            `json:"layer"`
	Brush string            `json:"brush"`
	Tool  string            `json:"tool"`
	Color string            `json:"color"`
	Size  float64           `json:"size"`
	Pts   []json.RawMessage `json:"pts"`
}

// LineStroke is one stroke of a Line: tool word, ARGB as 8 hex digits, xochitl thickness
// (1.0, 2.0, 3.0 for the toolbar's sizes), and points [x, y, pressure 0..1, width px].
type LineStroke struct {
	Tool      string
	ARGB      string
	Thickness float64
	Pts       [][4]float64
}

// Encode writes one socket line (no newline), built by hand so that the Go and Rust engines
// send the same bytes (numbers in their shortest form, strings escaped alike):
//
//	{"id":"a7","page":"<uuid>","layer":"agent","strokes":[{"tool":"fineliner","argb":"ff1f6fe0","thickness":2,"pts":[[x,y,p,w],...]}]}
func Encode(id, page string, ls LineStroke) []byte {
	b := make([]byte, 0, 96+len(ls.Pts)*32)
	b = append(b, `{"id":`...)
	b = appendString(b, id)
	b = append(b, `,"page":`...)
	b = appendString(b, page)
	b = append(b, `,"layer":"agent","strokes":[{"tool":`...)
	b = appendString(b, ls.Tool)
	b = append(b, `,"argb":`...)
	b = appendString(b, ls.ARGB)
	b = append(b, `,"thickness":`...)
	b = strconv.AppendFloat(b, ls.Thickness, 'f', -1, 64)
	b = append(b, `,"pts":[`...)
	for i, p := range ls.Pts {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		for j, v := range p {
			if j > 0 {
				b = append(b, ',')
			}
			b = strconv.AppendFloat(b, v, 'f', -1, 64)
		}
		b = append(b, ']')
	}
	return append(b, "]}]}"...)
}

// appendString writes s as a JSON string, escaping only what JSON requires (quote, backslash,
// control characters), the way the Rust engine does.
func appendString(b []byte, s string) []byte {
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"' || c == '\\':
			b = append(b, '\\', c)
		case c < 0x20:
			b = append(b, fmt.Sprintf(`\u%04x`, c)...)
		default:
			b = append(b, c)
		}
	}
	return append(b, '"')
}

// Handle follows one router message and returns the socket line to send, if a stroke ended.
// The second result says why a finished stroke was not sent ("" when it was, or nothing ended).
func (f *Forwarder) Handle(raw []byte, page Page) ([]byte, string) {
	var m message
	if json.Unmarshal(raw, &m) != nil || m.ID == "" {
		return nil, ""
	}
	if f.open == nil {
		f.open = map[string]*stroke{}
	}
	switch m.T {
	case "stroke_begin":
		if m.Layer != "ai" {
			return nil, ""
		}
		if len(f.open) >= or(f.MaxOpen, DefaultMaxOpen) {
			return nil, "too many open ai strokes"
		}
		size := m.Size
		f.open[m.ID] = &stroke{brush: firstOf(m.Tool, m.Brush), color: m.Color, size: size}
	case "stroke_pts":
		s := f.open[m.ID]
		if s == nil || s.tooMany {
			return nil, ""
		}
		for _, rp := range m.Pts {
			var p []float64
			if json.Unmarshal(rp, &p) != nil || len(p) < 2 {
				continue
			}
			if len(s.pts) >= or(f.MaxPoints, DefaultMaxPoints) {
				s.tooMany = true
				s.pts = nil
				break
			}
			s.pts = append(s.pts, p)
		}
	case "stroke_end":
		s := f.open[m.ID]
		if s == nil {
			return nil, ""
		}
		delete(f.open, m.ID)
		if s.tooMany {
			f.DroppedSize++
			return nil, fmt.Sprintf("stroke %s over %d points", m.ID, or(f.MaxPoints, DefaultMaxPoints))
		}
		if len(s.pts) == 0 {
			return nil, ""
		}
		if page.Page == "" {
			f.DroppedNoPage++
			return nil, "no open page known yet"
		}
		ls, why := Convert(s.brush, s.color, s.size, s.pts, page)
		if why != "" {
			f.DroppedSize++
			return nil, fmt.Sprintf("stroke %s: %s", m.ID, why)
		}
		if !f.take() {
			f.DroppedRate++
			return nil, "over the agent ink rate cap"
		}
		f.Sent++
		return Encode(m.ID, page.Page, ls), ""
	}
	return nil, ""
}

// take spends one token of the rate cap.
func (f *Forwarder) take() bool {
	now := time.Now()
	if f.Now != nil {
		now = f.Now()
	}
	burst := float64(or(f.Burst, DefaultBurst))
	if !f.started {
		f.started, f.tokens, f.refill = true, burst, now
	}
	per := f.PerSecond
	if per <= 0 {
		per = DefaultPerSecond
	}
	if dt := now.Sub(f.refill).Seconds(); dt > 0 {
		f.tokens = math.Min(burst, f.tokens+dt*per)
	}
	f.refill = now
	if f.tokens < 1 {
		return false
	}
	f.tokens--
	return true
}

// Convert maps one stroke to page coordinates (see the package comment). It refuses points off
// the page by more than half a page, which no reply needs and which would land out of sight.
func Convert(brush, color string, size float64, pts [][]float64, page Page) (LineStroke, string) {
	w, h := page.W, page.H
	if w <= 0 || h <= 0 {
		w, h = 1620, 2160
	}
	thickness := size
	if thickness <= 0 {
		thickness = 2
	}
	thickness = math.Max(1, math.Min(5, thickness))
	ls := LineStroke{Tool: ToolWord(brush), ARGB: fmt.Sprintf("%08x", ParseARGB(color)), Thickness: thickness}
	widthPx := 2 * thickness
	for _, p := range pts {
		x, y := p[0], p[1]
		if math.IsNaN(x) || math.IsNaN(y) || x < -0.5 || x > 1.5 || y < -0.5 || y > 1.5 {
			return LineStroke{}, fmt.Sprintf("point (%g, %g) is off the page", x, y)
		}
		pr := 0.6
		if len(p) >= 3 && p[2] >= 0 && p[2] <= 1 {
			pr = p[2]
		}
		ls.Pts = append(ls.Pts, [4]float64{round2(x*w - w/2), round2(y * h), round3(pr), widthPx})
	}
	return ls, ""
}

// ToolWord maps a protocol brush or tool to a tool the extension accepts. Anything it does not
// commit through addDrawingLine (highlighter, eraser, selection) or does not know becomes the
// fineliner: agent ink is always ink.
func ToolWord(brush string) string {
	switch strings.ToLower(brush) {
	case "ballpoint", "pen":
		return "ballpoint"
	case "pencil", "mechanical", "sharp_pencil", "marker", "calligraphy", "brush", "paintbrush":
		return strings.ToLower(brush)
	}
	return "fineliner"
}

// ParseARGB reads "#rrggbb" or "#rrggbbaa" (the protocol's colour hint) as 0xAARRGGBB; anything
// else, or a colour too light to read on paper (all channels above 0xe0), is DefaultARGB.
func ParseARGB(c string) uint32 {
	c = strings.TrimPrefix(strings.TrimSpace(c), "#")
	if len(c) != 6 && len(c) != 8 {
		return DefaultARGB
	}
	v, err := strconv.ParseUint(c, 16, 32)
	if err != nil {
		return DefaultARGB
	}
	var r, g, b, a uint32
	if len(c) == 6 {
		r, g, b, a = uint32(v>>16)&0xff, uint32(v>>8)&0xff, uint32(v)&0xff, 0xff
	} else {
		r, g, b, a = uint32(v>>24)&0xff, uint32(v>>16)&0xff, uint32(v>>8)&0xff, uint32(v)&0xff
	}
	if r > 0xe0 && g > 0xe0 && b > 0xe0 {
		return DefaultARGB
	}
	if a < 0x40 {
		a = 0xff // a near-transparent hint is a viewer's choice, not ink
	}
	return a<<24 | r<<16 | g<<8 | b
}

// PageOf reads the doc, page and size from a `page` message (the header fields only matter).
func PageOf(raw []byte) Page {
	var p struct {
		Doc  string  `json:"doc"`
		Page string  `json:"page"`
		W    float64 `json:"w"`
		H    float64 `json:"h"`
	}
	if json.Unmarshal(raw, &p) != nil {
		return Page{}
	}
	return Page{Doc: p.Doc, Page: p.Page, W: p.W, H: p.H}
}

// DockAction completes an action line from the extension for the router: it must be a JSON
// object with t "dock_action" and an id; the bridge adds the open document's id when the
// extension's page is the page it knows. Anything else is refused (nil).
func DockAction(line []byte, page Page) []byte {
	var m map[string]any
	if json.Unmarshal(line, &m) != nil || m["t"] != "dock_action" {
		return nil
	}
	if id, _ := m["id"].(string); id == "" || len(id) > 64 {
		return nil
	}
	if pg, _ := m["page"].(string); pg != "" && pg == page.Page && page.Doc != "" {
		m["doc"] = page.Doc
	}
	m["ts"] = time.Now().UnixMilli()
	b, _ := json.Marshal(m)
	return b
}

func or(v, def int) int {
	if v > 0 {
		return v
	}
	return def
}

func firstOf(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
