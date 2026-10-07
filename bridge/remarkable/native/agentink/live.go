package agentink

// Live agent ink, and the agent's "thinking" status, for the extension's overlay.
//
// # The problem
//
// A finished agent stroke reaches xochitl's page through the extension's commit chain (layer
// select, addDrawingLine, renderLineToTiles, wait, restore): about 150-300 ms per batch and one
// e-ink refresh per commit, after the stroke has ended. A reply written by the handwriting
// simulator therefore appeared in bursts, whole letters at a time, not as writing. The user's own
// pen shows ink as it moves. So while an agent stroke streams in, the bridge now also sends its
// points as they arrive, and the extension draws them at once in an overlay of its own in the
// e-paper Pen mode (codrawer-layer src/live.h); when the stroke ends, the native line is committed
// as before and the overlay's copy of it goes.
//
// # The socket lines (in addition to Encode's commit line)
//
//	{"op":"live","id":"<stroke id>","page":"<uuid>","argb":"ff1f6fe0","width":4,"pts":[[x,y,p,t],...]}
//	{"op":"live_end","id":"<stroke id>","committed":true}
//	{"op":"overlay","id":"<id>","kind":"thinking"|"clear","state":"thinking"|"writing"|"done","bbox":[x0,y0,x1,y1],"style":"pen"}
//
// `live` carries only the points new since the last one, in page units like the commit line
// (x centred), with each point's protocol timestamp t (ms; 0 when the point had none), so the
// overlay can play the stroke at the speed it was written. `width` is the drawn width in page px.
// `live_end` follows the commit line (or its refusal, then `committed` is false, and the overlay
// drops the stroke at once). Live lines obey the same layer, size and page rules as the commit;
// they are not rate-capped, because they draw nothing that lasts.
//
// `overlay` comes from the router's `agent_status` (an agent saying it is thinking about a
// selection, then writing, then done; docs/protocol.md): `thinking` starts a small animation
// beside `bbox` (page units, x centred, as the dock_action's selection bbox the agent answers);
// `writing` and `done` become `clear`, with `state` kept and, for `writing`, the answer block's
// bbox, where the doodle's nib hands over to.
//
// The lines are built by hand in a fixed key order, so the Go and Rust engines send the same bytes.

import (
	"encoding/json"
	"strconv"
)

// HandleAll follows one router message like Handle and returns every socket line it causes:
// a `live` line for new points of an open ai stroke, and at its end the commit line (if any)
// followed by `live_end`. why is Handle's.
func (f *Forwarder) HandleAll(raw []byte, page Page) (lines [][]byte, why string) {
	var m message
	if json.Unmarshal(raw, &m) != nil || m.ID == "" {
		return nil, ""
	}
	var before int
	s := f.open[m.ID]
	if s != nil {
		before = len(s.pts)
	}
	line, why := f.Handle(raw, page)
	switch m.T {
	case "stroke_pts":
		if s == nil || s.tooMany || page.Page == "" || len(s.pts) <= before {
			return nil, why
		}
		if l := liveLine(m.ID, page, s, s.pts[before:]); l != nil {
			lines = append(lines, l)
		}
	case "stroke_end":
		if s == nil {
			return nil, why
		}
		if line != nil {
			lines = append(lines, line)
		}
		lines = append(lines, LiveEnd(m.ID, line != nil))
	}
	return lines, why
}

// liveLine encodes new points of s; nil when one is off the page (the commit will refuse it).
func liveLine(id string, page Page, s *stroke, pts [][]float64) []byte {
	ls, why := Convert(s.brush, s.color, s.size, pts, page)
	if why != "" {
		return nil
	}
	b := make([]byte, 0, 96+len(pts)*32)
	b = append(b, `{"op":"live","id":`...)
	b = appendString(b, id)
	b = append(b, `,"page":`...)
	b = appendString(b, page.Page)
	b = append(b, `,"argb":`...)
	b = appendString(b, ls.ARGB)
	b = append(b, `,"width":`...)
	b = strconv.AppendFloat(b, 2*ls.Thickness, 'f', -1, 64)
	b = append(b, `,"pts":[`...)
	for i, p := range ls.Pts {
		if i > 0 {
			b = append(b, ',')
		}
		t := 0.0
		if len(pts[i]) >= 4 && pts[i][3] > 0 {
			t = pts[i][3]
		}
		b = append(b, '[')
		b = strconv.AppendFloat(b, p[0], 'f', -1, 64)
		b = append(b, ',')
		b = strconv.AppendFloat(b, p[1], 'f', -1, 64)
		b = append(b, ',')
		b = strconv.AppendFloat(b, p[2], 'f', -1, 64)
		b = append(b, ',')
		b = strconv.AppendFloat(b, t, 'f', -1, 64)
		b = append(b, ']')
	}
	return append(b, "]}"...)
}

// LiveEnd is the line that ends a live stroke.
func LiveEnd(id string, committed bool) []byte {
	b := append([]byte(`{"op":"live_end","id":`), appendString(nil, id)...)
	b = append(b, `,"committed":`...)
	b = strconv.AppendBool(b, committed)
	return append(b, '}')
}

// Overlay turns a router `agent_status` message into the overlay line; nil (and why) when it is
// not one, or is malformed. bbox is page units (x centred), each coordinate within the page's
// plausible range; style is "pen", "drop" or "glyph" (anything else: "pen").
func Overlay(raw []byte) ([]byte, string) {
	var m struct {
		T     string    `json:"t"`
		State string    `json:"state"`
		ID    string    `json:"id"`
		BBox  []float64 `json:"bbox"`
		Style string    `json:"style"`
		OK    *bool     `json:"ok"`
		Note  string    `json:"note"`
	}
	if json.Unmarshal(raw, &m) != nil || m.T != "agent_status" {
		return nil, "not an agent_status"
	}
	if m.ID == "" || len(m.ID) > 64 {
		return nil, "id must be 1..64 bytes"
	}
	kind := "clear"
	switch m.State {
	case "thinking":
		kind = "thinking"
	case "writing", "done":
	default:
		return nil, "state must be thinking, writing or done"
	}
	b := append([]byte(`{"op":"overlay","id":`), appendString(nil, m.ID)...)
	b = append(b, `,"kind":`...)
	b = appendString(b, kind)
	b = append(b, `,"state":`...)
	b = appendString(b, m.State)
	// bbox: required for thinking (where to doodle); for writing it is the answer's block, where
	// the nib hands over to
	if r := m.BBox; r != nil || kind == "thinking" {
		if len(r) != 4 || !(r[0] <= r[2] && r[1] <= r[3]) {
			return nil, "bbox must be [x0,y0,x1,y1]"
		}
		for i, v := range r {
			lo, hi := -2000.0, 2000.0
			if i%2 == 1 {
				hi = 40000
			}
			if !(v >= lo && v <= hi) {
				return nil, "bbox is off the page"
			}
		}
		b = append(b, `,"bbox":[`...)
		for i, v := range r {
			if i > 0 {
				b = append(b, ',')
			}
			b = strconv.AppendFloat(b, round2(v), 'f', -1, 64)
		}
		b = append(b, ']')
	}
	if kind == "thinking" {
		style := m.Style
		if style != "drop" && style != "glyph" {
			style = "pen"
		}
		b = append(b, `,"style":`...)
		b = appendString(b, style)
	}
	// done: whether the agent answered, and its one-line note, so the overlay can end with a
	// clear cue (a tick, or the note) rather than vanish
	if m.State == "done" && m.OK != nil {
		b = append(b, `,"ok":`...)
		b = strconv.AppendBool(b, *m.OK)
	}
	if n := CleanNote(m.Note); n != "" {
		b = append(b, `,"note":`...)
		b = appendString(b, n)
	}
	return append(b, '}'), ""
}

// NoteMax is the longest agent note the dock's status line carries, in runes.
const NoteMax = 100

// CleanNote makes an agent_status note one short line: control characters become spaces, runs
// of spaces fold, and it is cut to NoteMax runes.
func CleanNote(s string) string {
	out := make([]rune, 0, len(s))
	space := false
	for _, r := range s {
		if r < 0x20 || r == 0x7f || r == ' ' {
			if !space && len(out) > 0 {
				out = append(out, ' ')
			}
			space = true
			continue
		}
		space = false
		out = append(out, r)
		if len(out) >= NoteMax {
			break
		}
	}
	for len(out) > 0 && out[len(out)-1] == ' ' {
		out = out[:len(out)-1]
	}
	return string(out)
}

// StatusNote is what an agent_status means for the dock's status line: the note to show
// (set true) after a `done` with a note, or nothing to show (set true, note "") when a new
// request starts thinking; set is false for everything else, which leaves the line alone.
func StatusNote(raw []byte) (note string, set bool) {
	var m struct {
		T     string `json:"t"`
		State string `json:"state"`
		Note  string `json:"note"`
	}
	if json.Unmarshal(raw, &m) != nil || m.T != "agent_status" {
		return "", false
	}
	switch m.State {
	case "thinking":
		return "", true
	case "done":
		if n := CleanNote(m.Note); n != "" {
			return n, true
		}
	}
	return "", false
}
