package pagewatch

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"

	"codrawer-bridge-native/rmlines"
)

type pageMsg struct {
	T       string `json:"t"`
	Doc     string `json:"doc"`
	Page    string `json:"page"`
	Title   string `json:"title"`
	Rev     int64  `json:"rev"`
	W, H    int
	Strokes []struct {
		ID    string      `json:"id"`
		Tool  string      `json:"tool"`
		Color int         `json:"color"`
		RGBA  string      `json:"rgba"`
		Size  float64     `json:"size"`
		Layer string      `json:"layer"`
		Pts   [][]float64 `json:"pts"`
	} `json:"strokes"`
}

func decode(t *testing.T, b []byte) pageMsg {
	t.Helper()
	var m pageMsg
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("bad JSON: %v\n%.300s", err, b)
	}
	return m
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "rmlines", "testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func write(t *testing.T, path string, data []byte, mt time.Time) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatal(err)
	}
}

func contentJSON(open string, pages ...string) []byte {
	type pg struct {
		ID string `json:"id"`
	}
	var c struct {
		CPages struct {
			LastOpened struct {
				Timestamp string `json:"timestamp"`
				Value     string `json:"value"`
			} `json:"lastOpened"`
			Pages []pg `json:"pages"`
		} `json:"cPages"`
		FileType string `json:"fileType"`
	}
	c.CPages.LastOpened.Timestamp, c.CPages.LastOpened.Value, c.FileType = "1:2", open, "notebook"
	for _, p := range pages {
		c.CPages.Pages = append(c.CPages.Pages, pg{p})
	}
	b, _ := json.Marshal(c)
	return b
}

var t0 = time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)

func TestWatcherPublishesWritesAndPageTurns(t *testing.T) {
	dir := t.TempDir()
	const doc, p1, p2 = "doc-a", "page-1", "page-2"
	write(t, filepath.Join(dir, "doc-old.content"), contentJSON("x"), t0.Add(-time.Hour))
	write(t, filepath.Join(dir, doc+".metadata"), []byte(`{"visibleName":"Sketches","lastOpenedPage":0}`), t0)
	write(t, filepath.Join(dir, doc+".content"), contentJSON(p1, p1, p2), t0)
	write(t, filepath.Join(dir, doc, p1+".rm"), fixture(t, "paperpro_calligraphy.rm"), t0.Add(5*time.Second))

	w := &Watcher{Dir: dir}
	b, err := w.Poll()
	if err != nil || b == nil {
		t.Fatalf("first poll: %v %v", b, err)
	}
	m := decode(t, b)
	if m.T != "page" || m.Doc != doc || m.Page != p1 || m.Title != "Sketches" || len(m.Strokes) != 45 {
		t.Fatalf("first page: %+v", m)
	}
	if m.Rev != t0.Add(5*time.Second).UnixMilli() || m.W != 1620 || m.H != 2160 {
		t.Errorf("rev %d w %d h %d", m.Rev, m.W, m.H)
	}
	s := m.Strokes[0]
	if s.Tool != "calligraphy" || s.Color != 0 || s.RGBA != "#000000ff" || s.Size != 2 || s.Layer == "" || len(s.Pts) == 0 {
		t.Errorf("stroke %+v", s)
	}
	for _, st := range m.Strokes {
		for _, p := range st.Pts {
			if len(p) != 4 || p[0] < 0 || p[0] > 1 || p[1] < 0 || p[1] > 1 || p[2] < 0 || p[2] > 1 || p[3] <= 0 || p[3] > 0.03 {
				t.Fatalf("point %v out of range", p)
			}
		}
	}

	if b, err := w.Poll(); b != nil || err != nil {
		t.Fatalf("nothing changed, got %s %v", b, err)
	}

	// xochitl rewrites the page (an erase): a new snapshot, rev = the new mtime
	write(t, filepath.Join(dir, doc, p1+".rm"), fixture(t, "More_color_highlight_shader_v3.15.4.2.rm"), t0.Add(20*time.Second))
	b, _ = w.Poll()
	m = decode(t, b)
	if m.Page != p1 || m.Rev != t0.Add(20*time.Second).UnixMilli() || len(m.Strokes) != 23 {
		t.Fatalf("rewrite: page %s rev %d strokes %d", m.Page, m.Rev, len(m.Strokes))
	}
	tools := map[string]bool{}
	for _, st := range m.Strokes {
		tools[st.Tool] = true
		if st.Tool == "shader" && st.RGBA[7:] == "ff" {
			t.Errorf("shader alpha lost: %s", st.RGBA)
		}
	}
	if !tools["highlighter"] || !tools["shader"] || !tools["ballpoint"] {
		t.Errorf("tools %v", tools)
	}

	// a half-written file is not published; the next poll retries
	full := fixture(t, "paperpro_calligraphy.rm")
	write(t, filepath.Join(dir, doc, p1+".rm"), full[:len(full)/2], t0.Add(30*time.Second))
	if b, err := w.Poll(); b != nil || err == nil {
		t.Fatalf("truncated file published: %v", err)
	}
	write(t, filepath.Join(dir, doc, p1+".rm"), full, t0.Add(31*time.Second))
	if b, _ := w.Poll(); b == nil || len(decode(t, b).Strokes) != 45 {
		t.Fatal("retry after a partial write did not publish")
	}

	// page turn to a blank page: empty snapshot, rev = when the turn was saved
	write(t, filepath.Join(dir, doc+".content"), contentJSON(p2, p1, p2), t0.Add(40*time.Second))
	b, _ = w.Poll()
	m = decode(t, b)
	if m.Page != p2 || len(m.Strokes) != 0 || m.Rev != t0.Add(40*time.Second).UnixMilli() {
		t.Fatalf("turn: %+v", m)
	}

	// back to page 1, whose file is older than the turn: rev is the turn, not the old file
	write(t, filepath.Join(dir, doc+".content"), contentJSON(p1, p1, p2), t0.Add(50*time.Second))
	m = decode(t, mustPoll(t, w))
	if m.Page != p1 || len(m.Strokes) != 45 || m.Rev != t0.Add(50*time.Second).UnixMilli() {
		t.Fatalf("back: page %s strokes %d rev %d", m.Page, len(m.Strokes), m.Rev)
	}

	// another document opened (its .content is now the newest)
	write(t, filepath.Join(dir, "doc-b.content"), contentJSON("pb", "pb"), t0.Add(60*time.Second))
	m = decode(t, mustPoll(t, w))
	if m.Doc != "doc-b" || m.Page != "pb" || len(m.Strokes) != 0 {
		t.Fatalf("doc switch: %+v", m)
	}
}

func mustPoll(t *testing.T, w *Watcher) []byte {
	t.Helper()
	b, err := w.Poll()
	if err != nil || b == nil {
		t.Fatalf("poll: %v %v", b, err)
	}
	return b
}

func TestLocateFallbacks(t *testing.T) {
	dir := t.TempDir()
	// legacy content (a plain page list) + metadata index
	write(t, filepath.Join(dir, "d1.content"), []byte(`{"pages":["a","b","c"]}`), t0)
	write(t, filepath.Join(dir, "d1.metadata"), []byte(`{"visibleName":"Old","lastOpenedPage":2}`), t0)
	loc, err := Locate(dir)
	if err != nil || loc.Doc != "d1" || loc.Page != "c" || loc.Title != "Old" {
		t.Fatalf("legacy: %+v %v", loc, err)
	}
	// nothing usable in .content: the most recently written .rm
	write(t, filepath.Join(dir, "d2.content"), []byte(`{}`), t0.Add(time.Minute))
	write(t, filepath.Join(dir, "d2", "p-old.rm"), []byte(rmlines.Header), t0)
	write(t, filepath.Join(dir, "d2", "p-new.rm"), []byte(rmlines.Header), t0.Add(time.Second))
	loc, err = Locate(dir)
	if err != nil || loc.Doc != "d2" || loc.Page != "p-new" {
		t.Fatalf("fallback: %+v %v", loc, err)
	}
	if _, err := Locate(t.TempDir()); err == nil {
		t.Error("empty dir: want an error")
	}
}

// Strokes the codrawer-layer extension committed for an agent are labelled "ai", not with their
// layer id, so clients do not take them for the user's ink. The bytes match the Rust engine's.
func TestMessageLabelsTheAgentLayerAi(t *testing.T) {
	page := &rmlines.Page{PaperW: 1620, PaperH: 2160, Layers: []*rmlines.Layer{
		{ID: rmlines.CrdtID{Counter: 11}, Visible: true, Lines: []*rmlines.Line{{
			ID: rmlines.CrdtID{Author: 1, Counter: 5}, Layer: rmlines.CrdtID{Counter: 11}, Tool: 17, ThicknessScale: 2,
			Points: []rmlines.Point{{X: 0, Y: 1080, Pressure: 255, Width: 16}},
		}}},
		{ID: rmlines.CrdtID{Author: 1, Counter: 304}, Label: AgentLayer, Visible: true, Lines: []*rmlines.Line{{
			ID: rmlines.CrdtID{Author: 1, Counter: 305}, Layer: rmlines.CrdtID{Author: 1, Counter: 304}, Tool: 17, ThicknessScale: 2,
			Points: []rmlines.Point{{X: 0, Y: 1080, Pressure: 255, Width: 16}},
		}}},
	}}
	got := string(Message(Location{Doc: "d", Page: "p"}, 9, page))
	want := `{"t":"page","doc":"d","page":"p","rev":9,"w":1620,"h":2160,"strokes":[` +
		`{"id":"1:5","tool":"fineliner","color":0,"rgba":"#000000ff","size":2,"layer":"0:11","pts":[[0.5,0.5,1,0.002469]]},` +
		`{"id":"1:305","tool":"fineliner","color":0,"rgba":"#000000ff","size":2,"layer":"ai","pts":[[0.5,0.5,1,0.002469]]}]}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestMessageNormalises(t *testing.T) {
	page := &rmlines.Page{PaperW: 1620, PaperH: 2160, Layers: []*rmlines.Layer{
		{ID: rmlines.CrdtID{Author: 0, Counter: 11}, Visible: true, Lines: []*rmlines.Line{{
			ID: rmlines.CrdtID{Author: 1, Counter: 5}, Layer: rmlines.CrdtID{Author: 0, Counter: 11},
			Tool: rmlines.ToolHighlighter2, Color: rmlines.ColorHighlight, ThicknessScale: 1,
			ColorRGBA: &rmlines.RGBA{R: 255, G: 237, B: 117, A: 255},
			Points:    []rmlines.Point{{X: -810, Y: 0, Pressure: 255, Width: 120}, {X: 0, Y: 1080, Pressure: 0, Width: 16}, {X: 810, Y: 2700}},
		}}},
		{ID: rmlines.CrdtID{Author: 0, Counter: 12}, Visible: false, Lines: []*rmlines.Line{{Tool: 17, Points: []rmlines.Point{{}}}}},
	}}
	m := decode(t, Message(Location{Doc: "d", Page: "p"}, 42, page))
	if len(m.Strokes) != 1 {
		t.Fatalf("hidden layer leaked: %d strokes", len(m.Strokes))
	}
	s := m.Strokes[0]
	if s.ID != "1:5" || s.Tool != "highlighter" || s.Color != 9 || s.RGBA != "#ffed75ff" || s.Layer != "0:11" {
		t.Errorf("stroke %+v", s)
	}
	want := [][]float64{{0, 0, 1, 120.0 / 4 / 1620}, {0.5, 0.5, 0, 16.0 / 4 / 1620}, {1, 1.25, 0, 0}}
	for i, p := range s.Pts {
		for j := range p {
			if math.Abs(p[j]-want[i][j]) > 1e-5 {
				t.Fatalf("pt %d = %v, want %v", i, p, want[i])
			}
		}
	}
	if m := decode(t, Message(Location{Doc: "d", Page: "p"}, 7, nil)); len(m.Strokes) != 0 || m.Rev != 7 {
		t.Errorf("blank page %+v", m)
	}
}
