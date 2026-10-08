package pen

import (
	"encoding/json"
	"testing"
	"time"
)

type rig struct {
	m      *Machine
	now    time.Time
	out    []map[string]any
	refuse bool
	ts     int64
}

func newRig(t *testing.T) *rig {
	r := &rig{now: time.UnixMilli(1_790_000_000_000), ts: 1_790_000_000_000}
	r.m = New(Config{Brush: "pen", TouchMode: "auto", PressureThreshold: 0.02, FlushEvery: 16 * time.Millisecond, MaxBatch: 64, HoverEvery: 33 * time.Millisecond},
		Ranges{XMin: 0, XMax: 10000, YMin: 0, YMax: 10000, PMin: 0, PMax: 4096},
		func(b []byte) bool {
			if r.refuse {
				return false
			}
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatalf("emitted invalid JSON %s: %v", b, err)
			}
			r.out = append(r.out, m)
			return true
		})
	r.m.Now = func() time.Time { return r.now }
	return r
}

func (r *rig) ev(typ, code uint16, v int32) { r.m.Handle(Event{typ, code, v, r.ts}) }
func (r *rig) syn()                         { r.ev(EvSyn, SynReport, 0) }
func (r *rig) advance(ms int) {
	r.now = r.now.Add(time.Duration(ms) * time.Millisecond)
	r.ts += int64(ms)
}

// point reports one pen sample: down with pressure, at (x, y) device units.
func (r *rig) point(x, y int32) {
	r.ev(EvKey, BtnTouch, 1)
	r.ev(EvAbs, AbsX, x)
	r.ev(EvAbs, AbsY, y)
	r.ev(EvAbs, AbsPressure, 2048)
	r.syn()
}

func (r *rig) up() {
	r.ev(EvKey, BtnTouch, 0)
	r.ev(EvAbs, AbsPressure, 0)
	r.syn()
}

func types(out []map[string]any) []string {
	var s []string
	for _, m := range out {
		s = append(s, m["t"].(string))
	}
	return s
}

func TestFirstPointGoesOutImmediatelyThenBatches(t *testing.T) {
	r := newRig(t)
	r.point(1000, 2000)
	if got := types(r.out); len(got) != 2 || got[0] != "stroke_begin" || got[1] != "stroke_pts" {
		t.Fatalf("first point not immediate: %v", got)
	}
	for i := range 3 { // inside the 16 ms window: held
		r.advance(4)
		r.point(1010+int32(i)*10, 2000)
	}
	if len(r.out) != 2 {
		t.Fatalf("batched points leaked early: %v", types(r.out))
	}
	r.advance(5) // window closed
	r.point(1100, 2000)
	last := r.out[len(r.out)-1]
	if last["t"] != "stroke_pts" || len(last["pts"].([]any)) != 4 {
		t.Fatalf("batch: %v", last)
	}
	pt := last["pts"].([]any)[0].([]any)
	if pt[0].(float64) != 0.101 || pt[1].(float64) != 0.2 || pt[2].(float64) != 0.5 {
		t.Fatalf("point encoding: %v", pt)
	}
}

func TestPenUpFlushesAndEnds(t *testing.T) {
	r := newRig(t)
	r.point(1000, 1000)
	r.advance(2)
	r.point(1200, 1000) // pending in the batch
	r.up()
	got := types(r.out)
	want := []string{"stroke_begin", "stroke_pts", "stroke_pts", "stroke_end"}
	if len(got) != len(want) {
		t.Fatalf("got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v want %v", got, want)
		}
	}
	if r.m.Touching() || r.m.Strokes() != 1 {
		t.Fatalf("state after up: touching=%v strokes=%d", r.m.Touching(), r.m.Strokes())
	}
	// Hovering after the pen-up must not draw.
	r.ev(EvAbs, AbsX, 5000)
	r.ev(EvAbs, AbsY, 5000)
	r.syn()
	if len(r.out) != 4 {
		t.Fatalf("hover drew: %v", types(r.out))
	}
}

func TestRefusedOutboxSkipsTheRestOfTheStroke(t *testing.T) {
	r := newRig(t)
	r.point(1000, 1000)
	r.refuse = true // link down: outbox full
	for i := range 5 {
		r.advance(20)
		r.point(1100+int32(i)*100, 1000)
	}
	r.refuse = false // link back mid-stroke: the remainder stays skipped, no holes
	r.advance(20)
	r.point(2000, 1000)
	r.up()
	got := types(r.out)
	if len(got) != 3 || got[2] != "stroke_end" {
		t.Fatalf("want begin, first pts, end; got %v", got)
	}
	if r.m.LostStrokes() != 1 {
		t.Fatalf("lost strokes = %d", r.m.LostStrokes())
	}
	// The next stroke is whole again.
	r.advance(20)
	r.point(3000, 3000)
	if r.out[len(r.out)-2]["t"] != "stroke_begin" {
		t.Fatalf("next stroke: %v", types(r.out))
	}
}

func TestKernelTimestampIsUsed(t *testing.T) {
	r := newRig(t)
	r.ts -= 250 // events that waited 250 ms in a queue keep their real time
	r.point(1000, 1000)
	pt := r.out[1]["pts"].([]any)[0].([]any)
	if int64(pt[3].(float64)) != r.ts {
		t.Fatalf("ts %v, want kernel %d", pt[3], r.ts)
	}
}

func TestRubberEndIsEraser(t *testing.T) {
	r := newRig(t)
	r.ev(EvKey, BtnToolRubber, 1)
	r.point(1000, 1000)
	if r.out[0]["brush"] != "eraser" {
		t.Fatalf("brush: %v", r.out[0])
	}
}

func TestHoverSendsPacedCursorAndGone(t *testing.T) {
	r := newRig(t)
	r.ev(EvKey, BtnToolPen, 1) // in range, not touching
	for i := range 10 {
		r.ev(EvAbs, AbsX, 1000+int32(i)*100)
		r.ev(EvAbs, AbsY, 2000)
		r.syn()
		r.advance(10) // 100 Hz of reports; cursor at most every 33 ms
	}
	n := len(r.out)
	if n < 2 || n > 4 {
		t.Fatalf("want ~3 paced cursors, got %d: %v", n, types(r.out))
	}
	for _, m := range r.out {
		if m["t"] != "cursor" || m["who"] != "pen" || m["tool"] != "pen" {
			t.Fatalf("cursor: %v", m)
		}
	}
	// touching suppresses the cursor; the stroke flows as usual
	r.point(3000, 3000)
	if r.out[len(r.out)-2]["t"] != "stroke_begin" {
		t.Fatalf("stroke after hover: %v", types(r.out))
	}
	r.up()
	// leaving range sends one gone
	r.ev(EvKey, BtnToolPen, 0)
	r.syn()
	last := r.out[len(r.out)-1]
	if last["t"] != "cursor" || last["gone"] != true {
		t.Fatalf("want gone, got %v", last)
	}
}

func TestToolbarEraserMakesTipStrokesErasers(t *testing.T) {
	r := newRig(t)
	tool := "eraser"
	r.m.cfg.Tool = func() string { return tool }
	r.ev(EvKey, BtnToolPen, 1)
	r.point(1000, 1000)
	if r.out[0]["t"] != "stroke_begin" || r.out[0]["brush"] != "eraser" || r.out[0]["tool"] != "eraser" {
		t.Fatalf("toolbar eraser: %v", r.out[0])
	}
	r.up()
	// back to a pen in the toolbar: ink again
	tool = "pen"
	n := len(r.out)
	r.advance(50)
	r.point(2000, 2000)
	if r.out[n]["brush"] != "pen" || r.out[n]["tool"] != nil {
		t.Fatalf("toolbar pen: %v", r.out[n])
	}
}

func TestUnknownToolKeepsInk(t *testing.T) {
	for _, tool := range []string{"", "erase_area", "highlighter"} {
		r := newRig(t)
		r.m.cfg.Tool = func() string { return tool }
		r.point(1000, 1000)
		if r.out[0]["brush"] != "pen" || r.out[0]["tool"] != nil {
			t.Fatalf("tool %q: %v", tool, r.out[0])
		}
	}
}

func TestRubberEndStaysEraserWhateverTheToolbar(t *testing.T) {
	r := newRig(t)
	r.m.cfg.Tool = func() string { return "pen" }
	r.ev(EvKey, BtnToolRubber, 1)
	r.point(1000, 1000)
	if r.out[0]["brush"] != "eraser" || r.out[0]["tool"] != nil {
		t.Fatalf("eraser end: %v", r.out[0])
	}
}

func TestHoverShowsToolbarEraser(t *testing.T) {
	r := newRig(t)
	r.m.cfg.Tool = func() string { return "eraser" }
	r.ev(EvKey, BtnToolPen, 1)
	r.ev(EvAbs, AbsX, 1000)
	r.ev(EvAbs, AbsY, 1000)
	r.syn()
	if len(r.out) != 1 || r.out[0]["t"] != "cursor" || r.out[0]["tool"] != "eraser" {
		t.Fatalf("hover: %v", r.out)
	}
}

// The rM2 digitizer's axes differ from the portrait page. Ink and the loupe's hover
// pointer must use the same transform; otherwise the view jumps at pen-down.
func TestRotatedDigitizerInkAndHover(t *testing.T) {
	for _, tc := range []struct {
		name         string
		swap, ix, iy bool
		x, y         float64
	}{
		{"unchanged", false, false, false, .2, .7},
		{"swap", true, false, false, .7, .2},
		{"clockwise", true, true, false, .3, .2},
		{"counterclockwise", true, false, true, .7, .8},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			r.m.cfg.SwapXY, r.m.cfg.InvertX, r.m.cfg.InvertY = tc.swap, tc.ix, tc.iy
			r.m.rng = Ranges{XMin: 100, XMax: 1100, YMin: 200, YMax: 2200, PMax: 4096}
			r.ev(EvKey, BtnToolPen, 1)
			r.ev(EvAbs, AbsX, 300)
			r.ev(EvAbs, AbsY, 1600)
			r.syn()
			c := r.out[len(r.out)-1]
			if c["t"] != "cursor" || c["x"] != tc.x || c["y"] != tc.y {
				t.Fatalf("hover: %v", c)
			}
			r.point(300, 1600)
			var found bool
			for _, msg := range r.out {
				if msg["t"] == "stroke_pts" {
					p := msg["pts"].([]any)[0].([]any)
					if p[0] != tc.x || p[1] != tc.y {
						t.Fatalf("ink: %v", p)
					}
					found = true
				}
			}
			if !found {
				t.Fatal("missing ink")
			}
		})
	}
}
