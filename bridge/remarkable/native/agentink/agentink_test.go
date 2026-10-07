package agentink

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

var testPage = Page{Doc: "doc-1", Page: "ae4d6014-80e8-41c8-bb8a-e4686393a249", W: 1620, H: 2160}

func feed(f *Forwarder, page Page, msgs ...string) (lines []string, whys []string) {
	for _, m := range msgs {
		b, why := f.Handle([]byte(m), page)
		if b != nil {
			lines = append(lines, string(b))
		}
		if why != "" {
			whys = append(whys, why)
		}
	}
	return
}

func TestAiStrokeBecomesOneLineInPageCoordinates(t *testing.T) {
	f := &Forwarder{}
	lines, whys := feed(f, testPage,
		`{"t":"stroke_begin","id":"a1","layer":"ai","brush":"pen","color":"#d03030"}`,
		`{"t":"stroke_pts","id":"a1","pts":[[0.5,0.25,0.5,1730000000000],[0.75,0.5]]}`,
		`{"t":"stroke_end","id":"a1"}`)
	if len(whys) != 0 || len(lines) != 1 {
		t.Fatalf("lines %v whys %v", lines, whys)
	}
	want := `{"id":"a1","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","layer":"agent","strokes":[{"tool":"ballpoint","argb":"ffd03030","thickness":2,"pts":[[0,540,0.5,4],[405,1080,0.6,4]]}]}`
	if lines[0] != want {
		t.Fatalf("got  %s\nwant %s", lines[0], want)
	}
}

func TestOnlyTheAiLayerIsForwarded(t *testing.T) {
	f := &Forwarder{}
	for _, layer := range []string{"user", "peer", ""} {
		lines, _ := feed(f, testPage,
			`{"t":"stroke_begin","id":"u1","layer":"`+layer+`"}`,
			`{"t":"stroke_pts","id":"u1","pts":[[0.5,0.5,0.5]]}`,
			`{"t":"stroke_end","id":"u1"}`)
		if len(lines) != 0 {
			t.Fatalf("layer %q forwarded: %v", layer, lines)
		}
	}
}

func TestSizeCapsDropWholeStrokes(t *testing.T) {
	f := &Forwarder{MaxPoints: 3}
	_, whys := feed(f, testPage,
		`{"t":"stroke_begin","id":"big","layer":"ai"}`,
		`{"t":"stroke_pts","id":"big","pts":[[0.1,0.1],[0.2,0.2],[0.3,0.3],[0.4,0.4]]}`,
		`{"t":"stroke_end","id":"big"}`)
	if f.DroppedSize != 1 || len(whys) != 1 {
		t.Fatalf("dropped %d whys %v", f.DroppedSize, whys)
	}
	_, whys = feed(f, testPage,
		`{"t":"stroke_begin","id":"off","layer":"ai"}`,
		`{"t":"stroke_pts","id":"off","pts":[[0.5,30.0]]}`,
		`{"t":"stroke_end","id":"off"}`)
	if len(whys) != 1 || !strings.Contains(whys[0], "off the page") {
		t.Fatalf("off-page point: %v", whys)
	}
	// far down a scrolled page (request 48, 2026-10-07: y 1.69 page heights) is on the page
	if _, why := Convert("pen", "", 2, [][]float64{{0.25, 1.69}, {0.26, 1.70}}, testPage); why != "" {
		t.Fatalf("scrolled page refused: %s", why)
	}
	g := &Forwarder{MaxOpen: 1}
	_, whys = feed(g, testPage, `{"t":"stroke_begin","id":"x","layer":"ai"}`, `{"t":"stroke_begin","id":"y","layer":"ai"}`)
	if len(whys) != 1 {
		t.Fatalf("open cap: %v", whys)
	}
}

func TestRateCap(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	f := &Forwarder{Burst: 2, PerSecond: 1, Now: func() time.Time { return now }}
	one := func(id string) ([]string, []string) {
		return feed(f, testPage, `{"t":"stroke_begin","id":"`+id+`","layer":"ai"}`,
			`{"t":"stroke_pts","id":"`+id+`","pts":[[0.5,0.5]]}`, `{"t":"stroke_end","id":"`+id+`"}`)
	}
	for _, id := range []string{"a", "b"} {
		if l, _ := one(id); len(l) != 1 {
			t.Fatalf("%s within the burst was not sent", id)
		}
	}
	if l, _ := one("c"); len(l) != 0 || f.DroppedRate != 1 {
		t.Fatalf("over the burst was sent")
	}
	now = now.Add(1100 * time.Millisecond)
	if l, _ := one("d"); len(l) != 1 {
		t.Fatalf("after a refill nothing was sent")
	}
}

// The default cap admits agentd's "very fast" hand (about 14.4 strokes a second) for a long
// answer: 300 strokes at 15 a second, none dropped; bridge.env can change it, and bad values
// keep the default.
func TestDefaultRateAdmitsAVeryFastHand(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	f := &Forwarder{Now: func() time.Time { return now }}
	for i := 0; i < 300; i++ {
		id := "s" + strconv.Itoa(i)
		feed(f, testPage, `{"t":"stroke_begin","id":"`+id+`","layer":"ai"}`,
			`{"t":"stroke_pts","id":"`+id+`","pts":[[0.5,0.5]]}`, `{"t":"stroke_end","id":"`+id+`"}`)
		now = now.Add(time.Second / 15)
	}
	if f.DroppedRate != 0 || f.Sent != 300 {
		t.Fatalf("sent %d, dropped %d", f.Sent, f.DroppedRate)
	}
	if per, b := RateFromEnv("45", "90"); per != 45 || b != 90 {
		t.Fatalf("env: %v %v", per, b)
	}
	for _, bad := range [][2]string{{"", ""}, {"fast", "x"}, {"0", "0"}, {"500", "1000"}} {
		if per, b := RateFromEnv(bad[0], bad[1]); per != 0 || b != 0 {
			t.Fatalf("%v gave %v %v", bad, per, b)
		}
	}
}

func TestNoPageNoInk(t *testing.T) {
	f := &Forwarder{}
	lines, whys := feed(f, Page{}, `{"t":"stroke_begin","id":"a","layer":"ai"}`,
		`{"t":"stroke_pts","id":"a","pts":[[0.5,0.5]]}`, `{"t":"stroke_end","id":"a"}`)
	if len(lines) != 0 || len(whys) != 1 || f.DroppedNoPage != 1 {
		t.Fatalf("lines %v whys %v", lines, whys)
	}
}

func TestParseARGBAndToolWord(t *testing.T) {
	for in, want := range map[string]uint32{
		"#d03030": 0xffd03030, "#11223380": 0x80112233, "#ffffff": DefaultARGB, "": DefaultARGB,
		"red": DefaultARGB, "#1122330a": 0xff112233,
	} {
		if got := ParseARGB(in); got != want {
			t.Errorf("ParseARGB(%q) = %08x, want %08x", in, got, want)
		}
	}
	for in, want := range map[string]string{"pen": "ballpoint", "ghost": "fineliner", "eraser": "fineliner",
		"highlighter": "fineliner", "Calligraphy": "calligraphy", "": "fineliner"} {
		if got := ToolWord(in); got != want {
			t.Errorf("ToolWord(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEncodeEscapesStrings(t *testing.T) {
	got := string(Encode("a\"b\\c\n", "p", LineStroke{Tool: "fineliner", ARGB: "ff000000", Thickness: 1.5,
		Pts: [][4]float64{{-810, 0.25, 1, 3}}}))
	want := `{"id":"a\"b\\c\u000a","page":"p","layer":"agent","strokes":[{"tool":"fineliner","argb":"ff000000","thickness":1.5,"pts":[[-810,0.25,1,3]]}]}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

func TestDockActionGetsTheDoc(t *testing.T) {
	b := DockAction([]byte(`{"t":"dock_action","id":"ask_page","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","source":"dock"}`), testPage)
	if b == nil || !strings.Contains(string(b), `"doc":"doc-1"`) || !strings.Contains(string(b), `"ts":`) {
		t.Fatalf("got %s", b)
	}
	if DockAction([]byte(`{"t":"stroke_begin","id":"x"}`), testPage) != nil {
		t.Fatal("not a dock action, but relayed")
	}
	if b := DockAction([]byte(`{"t":"dock_action","id":"x","page":"other"}`), testPage); strings.Contains(string(b), `"doc"`) {
		t.Fatalf("doc added for another page: %s", b)
	}
}

func TestPageOf(t *testing.T) {
	p := PageOf([]byte(`{"t":"page","doc":"d","page":"p","w":1620,"h":2160,"strokes":[]}`))
	if p != (Page{Doc: "d", Page: "p", W: 1620, H: 2160}) {
		t.Fatalf("%+v", p)
	}
}
