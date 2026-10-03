package rmlines

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// ref is one file as Python rmscene parsed it (testdata/rmscene_dump.py → rmscene.json).
type ref struct {
	Lines []struct {
		ID     string    `json:"id"`
		Parent string    `json:"parent"`
		Tool   int       `json:"tool"`
		Color  int       `json:"color"`
		RGBA   []int     `json:"rgba"`
		Thick  float64   `json:"thick"`
		N      int       `json:"n"`
		P0     []float64 `json:"p0"`
		PN     []float64 `json:"pN"`
		WSum   float64   `json:"wsum"`
		PSum   float64   `json:"psum"`
	} `json:"lines"`
	Deleted []string    `json:"deleted"`
	Order   [][2]string `json:"order"`
	Paper   []int       `json:"paper"`
	Error   string      `json:"error"`
}

func loadRefs(t *testing.T) map[string]ref {
	t.Helper()
	b, err := os.ReadFile("testdata/rmscene.json")
	if err != nil {
		t.Fatal(err)
	}
	var refs map[string]ref
	if err := json.Unmarshal(b, &refs); err != nil {
		t.Fatal(err)
	}
	return refs
}

func parseFile(t *testing.T, name string) *Page {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Parse(b)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return p
}

func pointSlice(p Point) []float64 {
	return []float64{float64(p.X), float64(p.Y), float64(p.Speed), float64(p.Direction), float64(p.Width), float64(p.Pressure)}
}

func near(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if math.Abs(a[i]-b[i]) > 1e-3 {
			return false
		}
	}
	return true
}

// TestMatchesRmscene parses every fixture and compares stroke for stroke with rmscene:
// ids, layer, tool, colour, explicit RGBA, thickness, point count, first/last point (all six
// fields), sums of width and pressure, tombstones, drawing order and paper size.
func TestMatchesRmscene(t *testing.T) {
	refs := loadRefs(t)
	if len(refs) < 8 {
		t.Fatalf("only %d reference files", len(refs))
	}
	for name, want := range refs {
		t.Run(name, func(t *testing.T) {
			if want.Error != "" {
				t.Skipf("rmscene failed: %s", want.Error)
			}
			page := parseFile(t, name)
			if page.Skipped != 0 {
				t.Errorf("%d blocks skipped", page.Skipped)
			}
			got := map[string]*Line{}
			for _, l := range page.Lines() {
				got[l.ID.String()] = l
			}
			if len(got) != len(want.Lines) {
				t.Errorf("lines: got %d, rmscene %d", len(got), len(want.Lines))
			}
			for _, w := range want.Lines {
				l := got[w.ID]
				if l == nil {
					t.Errorf("line %s missing", w.ID)
					continue
				}
				if l.Tool != w.Tool || l.Color != w.Color || l.ThicknessScale != w.Thick || len(l.Points) != w.N {
					t.Errorf("line %s: tool %d/%d color %d/%d thick %v/%v n %d/%d", w.ID, l.Tool, w.Tool, l.Color, w.Color, l.ThicknessScale, w.Thick, len(l.Points), w.N)
				}
				if (l.ColorRGBA == nil) != (w.RGBA == nil) {
					t.Errorf("line %s: rgba %v, rmscene %v", w.ID, l.ColorRGBA, w.RGBA)
				} else if c := l.ColorRGBA; c != nil {
					if int(c.R) != w.RGBA[0] || int(c.G) != w.RGBA[1] || int(c.B) != w.RGBA[2] || int(c.A) != w.RGBA[3] {
						t.Errorf("line %s: rgba %v, rmscene %v", w.ID, *c, w.RGBA)
					}
				}
				if w.N > 0 {
					if !near(pointSlice(l.Points[0]), w.P0) || !near(pointSlice(l.Points[len(l.Points)-1]), w.PN) {
						t.Errorf("line %s: points %v..%v, rmscene %v..%v", w.ID, l.Points[0], l.Points[len(l.Points)-1], w.P0, w.PN)
					}
				}
				var ws, ps float64
				for _, p := range l.Points {
					ws += float64(p.Width)
					ps += float64(p.Pressure)
				}
				if math.Abs(ws-w.WSum) > 0.5 || math.Abs(ps-w.PSum) > 0.5 {
					t.Errorf("line %s: width sum %v/%v pressure sum %v/%v", w.ID, ws, w.WSum, ps, w.PSum)
				}
			}
			var gotDel []string
			for _, d := range page.Deleted {
				gotDel = append(gotDel, d.String())
			}
			wantDel := append([]string(nil), want.Deleted...)
			sort.Strings(gotDel)
			sort.Strings(wantDel)
			if len(gotDel) != len(wantDel) {
				t.Errorf("deleted: got %v, rmscene %v", gotDel, wantDel)
			} else {
				for i := range gotDel {
					if gotDel[i] != wantDel[i] {
						t.Errorf("deleted: got %v, rmscene %v", gotDel, wantDel)
						break
					}
				}
			}
			// drawing order and layer, exactly as rmscene's tree walk
			lines := page.Lines()
			if len(lines) == len(want.Order) {
				for i, o := range want.Order {
					if lines[i].ID.String() != o[0] || lines[i].Layer.String() != o[1] {
						t.Errorf("order[%d]: got %s in %s, rmscene %s in %s", i, lines[i].ID, lines[i].Layer, o[0], o[1])
						break
					}
				}
			} else {
				t.Errorf("order: got %d lines, rmscene %d", len(lines), len(want.Order))
			}
			if len(want.Paper) == 2 && (page.PaperW != want.Paper[0] || page.PaperH != want.Paper[1]) {
				t.Errorf("paper %dx%d, rmscene %v", page.PaperW, page.PaperH, want.Paper)
			}
		})
	}
}

// The page copied from the Paper Pro (Codex 6.0.105): 45 calligraphy strokes in black at size 2,
// x centred −586…606, y 143…1673, per-point width 8…42 (docs/investigations/xochitl-pen-data.md).
func TestPaperProCalligraphyPage(t *testing.T) {
	p := parseFile(t, "paperpro_calligraphy.rm")
	lines := p.Lines()
	if len(lines) != 45 {
		t.Fatalf("lines %d, want 45", len(lines))
	}
	minX, maxX, minY, maxY := math.Inf(1), math.Inf(-1), math.Inf(1), math.Inf(-1)
	minW, maxW := math.Inf(1), math.Inf(-1)
	for _, l := range lines {
		if ToolName(l.Tool) != "calligraphy" || l.Color != ColorBlack || l.ThicknessScale != 2 {
			t.Fatalf("stroke %s: tool %d color %d size %v", l.ID, l.Tool, l.Color, l.ThicknessScale)
		}
		for _, pt := range l.Points {
			minX, maxX = math.Min(minX, float64(pt.X)), math.Max(maxX, float64(pt.X))
			minY, maxY = math.Min(minY, float64(pt.Y)), math.Max(maxY, float64(pt.Y))
			minW, maxW = math.Min(minW, float64(pt.Width)), math.Max(maxW, float64(pt.Width))
		}
	}
	if minX < -600 || maxX > 620 || minY < 130 || maxY > 1690 || minW < 8 || maxW > 42 {
		t.Errorf("x %v..%v y %v..%v width %v..%v", minX, maxX, minY, maxY, minW, maxW)
	}
	if p.PaperW != 1620 || p.PaperH != 2160 {
		t.Errorf("paper %dx%d", p.PaperW, p.PaperH)
	}
}

// Paper Pro inks: colour ids 9–13, highlighter and shader carrying their colour in color_rgba.
func TestPaperProColours(t *testing.T) {
	p := parseFile(t, "More_color_highlight_shader_v3.15.4.2.rm")
	tools := map[string]bool{}
	var shader, highlighter *Line
	for _, l := range p.Lines() {
		tools[ToolName(l.Tool)] = true
		switch l.Tool {
		case ToolShader:
			shader = l
		case ToolHighlighter2:
			highlighter = l
		}
	}
	for _, want := range []string{"ballpoint", "highlighter", "shader"} {
		if !tools[want] {
			t.Errorf("no %s in %v", want, tools)
		}
	}
	if shader == nil || shader.Color != ColorHighlight || shader.ColorRGBA == nil || shader.ColorRGBA.A == 255 {
		t.Errorf("shader %+v", shader)
	}
	if highlighter == nil || highlighter.ColorRGBA == nil {
		t.Errorf("highlighter %+v", highlighter)
	}
	if got := PaletteRGBA(ColorCyan); got != (RGBA{139, 208, 229, 255}) {
		t.Errorf("cyan %v", got)
	}
	l := &Line{Color: ColorBlue}
	if l.RGBA() != PaletteRGBA(ColorBlue) {
		t.Error("palette fallback")
	}
	if len(p.Deleted) == 0 {
		t.Error("expected tombstones (erased strokes) in this fixture")
	}
}

func TestLayers(t *testing.T) {
	p := parseFile(t, "Normal_A_stroke_2_layers_v3.3.2.rm")
	if len(p.Layers) < 2 {
		t.Fatalf("layers %d", len(p.Layers))
	}
	for _, l := range p.Layers {
		if l.Label == "" {
			t.Errorf("layer %s has no label", l.ID)
		}
	}
}

func TestToolNames(t *testing.T) {
	for id, want := range map[int]string{
		0: "brush", 12: "brush", 1: "pencil", 14: "pencil", 2: "ballpoint", 15: "ballpoint", 3: "marker", 16: "marker",
		4: "fineliner", 17: "fineliner", 5: "highlighter", 18: "highlighter", 6: "eraser", 7: "mechanical_pencil",
		13: "mechanical_pencil", 8: "erase_area", 21: "calligraphy", 23: "shader", 99: "pen",
	} {
		if got := ToolName(id); got != want {
			t.Errorf("ToolName(%d) = %s, want %s", id, got, want)
		}
	}
}

func TestBadInput(t *testing.T) {
	if _, err := Parse([]byte("not a file")); !errors.Is(err, ErrHeader) {
		t.Errorf("header: %v", err)
	}
	b, err := os.ReadFile("testdata/paperpro_calligraphy.rm")
	if err != nil {
		t.Fatal(err)
	}
	// a file cut mid-write must be an error, never a page with strokes missing
	for _, n := range []int{len(Header) + 3, len(b) / 2, len(b) - 1} {
		if _, err := Parse(b[:n]); !errors.Is(err, ErrTruncated) {
			t.Errorf("cut at %d: %v", n, err)
		}
	}
	if p, err := Parse([]byte(Header)); err != nil || len(p.Lines()) != 0 {
		t.Errorf("empty page: %v %v", p, err)
	}
}

func FuzzParse(f *testing.F) {
	for _, name := range []string{"paperpro_calligraphy.rm", "More_color_highlight_shader_v3.15.4.2.rm"} {
		if b, err := os.ReadFile(filepath.Join("testdata", name)); err == nil {
			f.Add(b[:min(len(b), 4096)])
		}
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		_, _ = Parse(b) // must never panic
	})
}
