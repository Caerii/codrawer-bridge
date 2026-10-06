// Package pen turns raw evdev pen events into codrawer stroke messages (docs/protocol.md:
// stroke_begin, stroke_pts, stroke_end, and cursor while hovering).
//
// # The problem
//
// The Paper Pro's pen (the Elan marker, /dev/input/event2) reports absolute axes (x, y,
// pressure, distance) and tool keys (BTN_TOUCH, BTN_TOOL_PEN, BTN_TOOL_RUBBER), grouped into
// samples by SYN_REPORT. The keys tell the eraser end from the tip, but not the tool picked in
// xochitl's toolbar: that comes from Config.Tool (package toolhint), when xochitl reports it. A stroke is the run of samples between contact and lift. The bridge has
// to cut that stream into strokes, normalise the coordinates, batch the points for the network
// (~60 batches/s, ADR 006) and survive a network that comes and goes.
//
// # Invariants
//
//   - One Machine lives for the whole process and sees every event, whatever the state of the
//     network. Contact state can never be lost to a stalled socket: a dropped pen-up once left
//     the pen "down", so hovering drew ink. That is why the machine is not per connection.
//   - Messages go to Emit, which never blocks. When it refuses a stroke message (the outbox is
//     full because the link is down), the rest of that stroke is skipped as a whole rather than
//     event by event, so receivers never see a stroke with holes or two strokes merged. The
//     stroke_end is still attempted, so a receiver that saw the beginning can close it.
//   - Cursor messages are ephemeral: a refused one is simply dropped and never affects strokes.
//
// # Units on the wire
//
// x, y: normalised to the device's axis ranges, 0..1, 4 decimals (≈ 0.2 px on the 2160-px
// axis). p: pressure 0..1, 3 decimals. Timestamps: Unix milliseconds from the kernel's event
// time (the tablet's clock), so stroke velocity stays true even when events queue up.
//
// The package is pure logic, with no device or socket access, so it is unit-tested on any OS.
// Reading order: the types, then Handle → report (contact transitions, then one point), then
// batching (Flush), then hover.
package pen

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Linux input constants this package interprets (input-event-codes.h). The bridge's device code
// uses the same ones.
const (
	EvSyn = 0x00
	EvKey = 0x01
	EvAbs = 0x03

	SynReport  = 0x00 // end of one coherent sample
	SynDropped = 0x03 // the kernel's buffer overflowed; events were lost

	BtnTouch      = 0x14A // the tip touches the screen
	BtnToolPen    = 0x140 // the tip end is in range
	BtnToolRubber = 0x141 // the eraser end is in range

	AbsX        = 0x00
	AbsY        = 0x01
	AbsPressure = 0x18
	AbsDistance = 0x19 // height above the screen, device units
)

// Event is one input_event, with its kernel timestamp in Unix milliseconds.
type Event struct {
	Type   uint16
	Code   uint16
	Value  int32
	TimeMS int64
}

// Ranges are the device's axis ranges (EVIOCGABS), in device units; normalised values are
// (v - min) / (max - min), clamped to 0..1.
type Ranges struct {
	XMin, XMax int32
	YMin, YMax int32
	PMin, PMax int32
}

// Config is how the machine detects contact and paces its output.
type Config struct {
	Brush string // brush hint for pen strokes ("pen"); the rubber end is always "eraser"
	Color string // optional colour hint ("#00ff88"); raw input does not carry the UI's colour
	// TouchMode decides what counts as contact: "auto" (BTN_TOUCH when set, else pressure), "btn",
	// "pressure", "distance" or "tool". Unknown values behave as "btn".
	TouchMode         string
	PressureThreshold float64       // pressure mode: down when normalised pressure > this (0..1)
	DistanceThreshold int           // distance mode: down when ABS_DISTANCE <= this (device units)
	FlushEvery        time.Duration // batch window after the first point of a stroke
	MaxBatch          int           // flush early at this many points (default 64)
	// HoverEvery paces `cursor` messages while the pen hovers in range without touching
	// (a pointer for viewers to follow); 0 disables them.
	HoverEvery time.Duration
	// Tool, if set, reports the tool xochitl's toolbar has selected for the tip ("eraser",
	// "pen", …, or "" when unknown; package toolhint). It is asked at each pen-down with the tip
	// and on hover samples. "eraser" makes a tip stroke an eraser stroke, the same as the eraser end.
	Tool func() string
}

// sample is the device state as of the latest event: evdev reports only what changed, so the
// machine accumulates it and interprets it at each SYN_REPORT.
type sample struct {
	x, y, p, d int32 // device units
	hasX, hasY bool  // no point can be placed before both axes were reported once
	btnTouch   bool
	toolPen    bool
	toolRubber bool
}

// Machine is the pen state machine. It is not safe for concurrent use.
type Machine struct {
	cfg  Config
	rng  Ranges
	mode string // TouchMode, normalised
	// Emit delivers one encoded message; false means it could not be queued.
	Emit func(msg []byte) bool
	// OnStroke, if set, is called at pen-down (true) and pen-up (false).
	OnStroke func(down bool)
	// Now is the clock for batching and fallback timestamps (tests replace it).
	Now func() time.Time

	dev sample

	// the stroke in progress
	touching     bool
	lost         bool // the current stroke's messages are being skipped
	id           string
	brush        string
	lastX, lastY float64 // the last point sent, normalised, for the jitter filter
	haveLast     bool

	// the pending batch of points
	batch     []byte // encoded points, comma separated
	batchN    int
	lastFlush time.Time

	// hover pointer
	hovering       bool // a cursor was sent and no "gone" since
	lastHover      time.Time
	hoverX, hoverY float64

	strokes, lostStroke int64
}

// New returns a machine for a device with the given ranges, emitting through emit.
func New(cfg Config, rng Ranges, emit func([]byte) bool) *Machine {
	mode := strings.ToLower(strings.TrimSpace(cfg.TouchMode))
	if mode == "" {
		mode = "auto"
	}
	if cfg.MaxBatch <= 0 {
		cfg.MaxBatch = 64
	}
	return &Machine{cfg: cfg, rng: rng, mode: mode, Emit: emit, Now: time.Now, brush: cfg.Brush}
}

// Touching reports whether a stroke is in progress.
func (m *Machine) Touching() bool { return m.touching }

// Strokes counts completed strokes.
func (m *Machine) Strokes() int64 { return m.strokes }

// LostStrokes counts strokes whose messages were (partly) skipped because Emit refused one.
func (m *Machine) LostStrokes() int64 { return m.lostStroke }

// ── events ──────────────────────────────────────────────────────────────────

// Handle consumes one event and emits whatever messages it completes.
func (m *Machine) Handle(ev Event) {
	switch ev.Type {
	case EvAbs:
		switch ev.Code {
		case AbsX:
			m.dev.x, m.dev.hasX = ev.Value, true
		case AbsY:
			m.dev.y, m.dev.hasY = ev.Value, true
		case AbsPressure:
			m.dev.p = ev.Value
		case AbsDistance:
			m.dev.d = ev.Value
		}
	case EvKey:
		switch ev.Code {
		case BtnTouch:
			m.dev.btnTouch = ev.Value != 0
		case BtnToolPen:
			m.dev.toolPen = ev.Value != 0
		case BtnToolRubber:
			m.dev.toolRubber = ev.Value != 0
		}
	case EvSyn:
		if ev.Code == SynReport {
			m.report(ev.TimeMS)
		}
	}
}

// down applies the touch mode to the current sample.
func (m *Machine) down() bool {
	mode := m.mode
	if mode == "auto" {
		// prefer BTN_TOUCH when it is set, else the pressure threshold
		if m.dev.btnTouch {
			return true
		}
		mode = "pressure"
	}
	switch mode {
	case "pressure":
		return norm(m.dev.p, m.rng.PMin, m.rng.PMax) > m.cfg.PressureThreshold
	case "distance":
		return int(m.dev.d) <= m.cfg.DistanceThreshold
	case "tool":
		return m.dev.toolPen || m.dev.toolRubber
	default: // btn
		return m.dev.btnTouch
	}
}

// report handles one SYN_REPORT: a contact transition if there is one, then one coherent point
// (or, out of contact, the hover pointer).
func (m *Machine) report(tsMS int64) {
	now := m.Now()
	tsMS = eventTime(tsMS, now)
	down := m.down()
	switch {
	case down && !m.touching:
		m.beginStroke(now, tsMS)
	case !down && m.touching:
		m.endStroke(tsMS)
		return
	}
	if !m.touching {
		m.hover(now, tsMS)
		return
	}
	m.addPoint(tsMS)
}

// eventTime is the kernel timestamp, or the wall clock if the device clock is clearly off (not
// set yet at boot: more than 10 minutes from now, or missing).
func eventTime(tsMS int64, now time.Time) int64 {
	if tsMS <= 0 || math.Abs(float64(tsMS-now.UnixMilli())) > 10*60*1000 {
		return now.UnixMilli()
	}
	return tsMS
}

// ── strokes ─────────────────────────────────────────────────────────────────

// beginStroke starts a stroke: a fresh id and batch, and stroke_begin. The point of the same
// sample follows (report), and goes out at once.
func (m *Machine) beginStroke(now time.Time, tsMS int64) {
	m.touching, m.lost, m.haveLast = true, false, false
	m.batch, m.batchN = m.batch[:0], 0
	m.lastFlush = time.Time{} // the first point goes out at once
	m.brush = m.cfg.Brush
	toolbar := false // the eraser came from xochitl's toolbar, not from the pen's eraser end
	switch {
	case m.dev.toolRubber:
		m.brush = "eraser"
	case m.toolbarEraser():
		m.brush, toolbar = "eraser", true
	}
	m.id = fmt.Sprintf("u_%x", now.UnixNano())
	msg := []byte(`{"t":"stroke_begin","id":"` + m.id + `","layer":"user","brush":`)
	msg = strconv.AppendQuote(msg, m.brush) // config strings are ASCII; Go quoting is valid JSON
	if toolbar {
		// receivers treat it as any eraser (brush); `tool` says it is xochitl's toolbar Eraser
		msg = append(msg, `,"tool":"eraser"`...)
	}
	if m.cfg.Color != "" {
		msg = append(msg, `,"color":`...)
		msg = strconv.AppendQuote(msg, m.cfg.Color)
	}
	msg = append(msg, `,"ts":`...)
	msg = strconv.AppendInt(msg, tsMS, 10)
	msg = append(msg, '}')
	if m.OnStroke != nil {
		m.OnStroke(true)
	}
	m.send(msg)
}

// toolbarEraser reports whether xochitl's toolbar has the Eraser selected, so that the tip
// erases. Unknown (no Config.Tool, or it returns "") is false: the stroke stays ink, as before.
func (m *Machine) toolbarEraser() bool {
	return m.cfg.Tool != nil && m.cfg.Tool() == "eraser"
}

// endStroke flushes the pending points and sends stroke_end.
func (m *Machine) endStroke(tsMS int64) {
	m.Flush(true)
	msg := []byte(`{"t":"stroke_end","id":"` + m.id + `","ts":`)
	msg = strconv.AppendInt(msg, tsMS, 10)
	msg = append(msg, '}')
	// The end goes out even after a skipped stroke: if it gets through, receivers close the
	// stroke now instead of when the router notices we left.
	m.lost = false
	m.send(msg)
	m.touching = false
	m.strokes++
	if m.OnStroke != nil {
		m.OnStroke(false)
	}
}

// addPoint appends the current sample to the batch as [x, y, p, t], unless it is sub-pixel
// jitter from the last point, and flushes if the batch is due.
func (m *Machine) addPoint(tsMS int64) {
	if !m.dev.hasX || !m.dev.hasY {
		return
	}
	x := norm(m.dev.x, m.rng.XMin, m.rng.XMax)
	y := norm(m.dev.y, m.rng.YMin, m.rng.YMax)
	if m.haveLast {
		dx, dy := x-m.lastX, y-m.lastY
		if dx*dx+dy*dy < 1e-8 { // sub-pixel jitter (0.0001 of the axis)
			return
		}
	}
	m.lastX, m.lastY, m.haveLast = x, y, true
	if m.batchN > 0 {
		m.batch = append(m.batch, ',')
	}
	// 4 decimals ≈ 0.2 px on the 2160-px axis; about half the bytes of full float64 output.
	m.batch = append(m.batch, '[')
	m.batch = appendFixed(m.batch, x, 4)
	m.batch = append(m.batch, ',')
	m.batch = appendFixed(m.batch, y, 4)
	m.batch = append(m.batch, ',')
	m.batch = appendFixed(m.batch, norm(m.dev.p, m.rng.PMin, m.rng.PMax), 3)
	m.batch = append(m.batch, ',')
	m.batch = strconv.AppendInt(m.batch, tsMS, 10)
	m.batch = append(m.batch, ']')
	m.batchN++
	m.Flush(false)
}

// send emits a stroke message unless the stroke is being skipped; a refusal starts skipping.
func (m *Machine) send(msg []byte) {
	if m.lost {
		return
	}
	if !m.Emit(msg) {
		m.lost = true // skip the rest of this stroke; the router ends it if we drop off
		m.lostStroke++
	}
}

// ── batching ────────────────────────────────────────────────────────────────

// Pending reports whether points are waiting for the batch window, and when it closes. The
// bridge arms its flush timer from this, so an idle pen causes no wakeups.
func (m *Machine) Pending() (bool, time.Time) {
	return m.batchN > 0, m.lastFlush.Add(m.cfg.FlushEvery)
}

// Flush sends the pending batch as one stroke_pts if its window has closed or it reached
// MaxBatch (or always, with force).
func (m *Machine) Flush(force bool) {
	if m.batchN == 0 {
		return
	}
	if !force && m.Now().Sub(m.lastFlush) < m.cfg.FlushEvery && m.batchN < m.cfg.MaxBatch {
		return
	}
	msg := make([]byte, 0, len(m.batch)+64)
	msg = append(msg, `{"t":"stroke_pts","id":"`...)
	msg = append(msg, m.id...)
	msg = append(msg, `","pts":[`...)
	msg = append(msg, m.batch...)
	msg = append(msg, "]}"...)
	m.batch = m.batch[:0]
	m.batchN = 0
	m.lastFlush = m.Now()
	m.send(msg)
}

// ── hover ───────────────────────────────────────────────────────────────────

// hover sends the pen's position while it is in range but not touching, paced by HoverEvery and
// only when it moved (by 0.002 of either axis), and one {"gone":true} when it leaves range.
func (m *Machine) hover(now time.Time, tsMS int64) {
	if m.cfg.HoverEvery <= 0 {
		return
	}
	inRange := m.dev.toolPen || m.dev.toolRubber
	if !inRange {
		if m.hovering {
			m.hovering = false
			m.Emit([]byte(`{"t":"cursor","who":"pen","gone":true}`))
		}
		return
	}
	if !m.dev.hasX || !m.dev.hasY || now.Sub(m.lastHover) < m.cfg.HoverEvery {
		return
	}
	x := norm(m.dev.x, m.rng.XMin, m.rng.XMax)
	y := norm(m.dev.y, m.rng.YMin, m.rng.YMax)
	if m.hovering && math.Abs(x-m.hoverX) < 0.002 && math.Abs(y-m.hoverY) < 0.002 {
		return // still: nothing new to show
	}
	m.lastHover, m.hoverX, m.hoverY, m.hovering = now, x, y, true
	msg := []byte(`{"t":"cursor","who":"pen","x":`)
	msg = appendFixed(msg, x, 4)
	msg = append(msg, `,"y":`...)
	msg = appendFixed(msg, y, 4)
	msg = append(msg, `,"tool":`...)
	if m.dev.toolRubber || m.toolbarEraser() {
		msg = append(msg, `"eraser"`...)
	} else {
		msg = append(msg, `"pen"`...)
	}
	msg = append(msg, `,"ts":`...)
	msg = strconv.AppendInt(msg, tsMS, 10)
	msg = append(msg, '}')
	m.Emit(msg)
}

// ── encoding ────────────────────────────────────────────────────────────────

// norm maps v from [lo, hi] to 0..1, clamped; a degenerate range gives 0.
func norm(v, lo, hi int32) float64 {
	if hi <= lo {
		return 0
	}
	return math.Min(1, math.Max(0, float64(v-lo)/float64(hi-lo)))
}

// appendFixed writes v rounded to n decimals without trailing zeros (0.1235, 1, 0).
func appendFixed(b []byte, v float64, n int) []byte {
	s := math.Pow(10, float64(n))
	return strconv.AppendFloat(b, math.Round(v*s)/s, 'f', -1, 64)
}
