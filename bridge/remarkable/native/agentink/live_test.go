package agentink

import (
	"strings"
	"testing"
)

func all(f *Forwarder, page Page, msgs ...string) (lines []string) {
	for _, m := range msgs {
		ls, _ := f.HandleAll([]byte(m), page)
		for _, l := range ls {
			lines = append(lines, string(l))
		}
	}
	return lines
}

// The same inputs and bytes as the Rust engine's live tests (agent_ink.rs).
func TestLiveLinesFollowTheStroke(t *testing.T) {
	f := &Forwarder{}
	got := all(f, testPage,
		`{"t":"stroke_begin","id":"a1","layer":"ai","brush":"pen","color":"#d03030"}`,
		`{"t":"stroke_pts","id":"a1","pts":[[0.5,0.25,0.5,1730000000000],[0.75,0.5]]}`,
		`{"t":"stroke_pts","id":"a1","pts":[[0.5,0.5,0.7,1730000000040]]}`,
		`{"t":"stroke_end","id":"a1"}`,
	)
	want := []string{
		`{"op":"live","id":"a1","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","argb":"ffd03030","width":4,"pts":[[0,540,0.5,1730000000000],[405,1080,0.6,0]]}`,
		`{"op":"live","id":"a1","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","argb":"ffd03030","width":4,"pts":[[0,1080,0.7,1730000000040]]}`,
		`{"id":"a1","page":"ae4d6014-80e8-41c8-bb8a-e4686393a249","layer":"agent","strokes":[{"tool":"ballpoint","argb":"ffd03030","thickness":2,"pts":[[0,540,0.5,4],[405,1080,0.6,4],[0,1080,0.7,4]]}]}`,
		`{"op":"live_end","id":"a1","committed":true}`,
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("got\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
}

func TestLiveOnlyForAiAndAKnownPage(t *testing.T) {
	f := &Forwarder{}
	if got := all(f, testPage,
		`{"t":"stroke_begin","id":"u","layer":"user"}`,
		`{"t":"stroke_pts","id":"u","pts":[[0.5,0.5]]}`,
		`{"t":"stroke_end","id":"u"}`); len(got) != 0 {
		t.Fatalf("user ink went live: %v", got)
	}
	got := all(&Forwarder{}, Page{},
		`{"t":"stroke_begin","id":"a","layer":"ai"}`,
		`{"t":"stroke_pts","id":"a","pts":[[0.5,0.5]]}`,
		`{"t":"stroke_end","id":"a"}`)
	if len(got) != 1 || got[0] != `{"op":"live_end","id":"a","committed":false}` {
		t.Fatalf("no page: %v", got)
	}
	// a stroke over the point cap is never live and ends uncommitted
	g := &Forwarder{MaxPoints: 2}
	got = all(g, testPage,
		`{"t":"stroke_begin","id":"b","layer":"ai"}`,
		`{"t":"stroke_pts","id":"b","pts":[[0.1,0.1],[0.2,0.2],[0.3,0.3]]}`,
		`{"t":"stroke_end","id":"b"}`)
	if len(got) != 1 || !strings.Contains(got[0], `"committed":false`) {
		t.Fatalf("over the cap: %v", got)
	}
}

func TestOverlayFromAgentStatus(t *testing.T) {
	line, why := Overlay([]byte(`{"t":"agent_status","state":"thinking","id":"q1","bbox":[-480.81,2982.8,-270.9,3314.7]}`))
	if why != "" || string(line) != `{"op":"overlay","id":"q1","kind":"thinking","state":"thinking","bbox":[-480.81,2982.8,-270.9,3314.7],"style":"pen"}` {
		t.Fatalf("%s %q", line, why)
	}
	line, _ = Overlay([]byte(`{"t":"agent_status","state":"thinking","id":"q1","bbox":[0,0,10,10],"style":"glyph"}`))
	if !strings.Contains(string(line), `"style":"glyph"`) {
		t.Fatalf("%s", line)
	}
	for _, s := range []string{"writing", "done"} {
		line, _ = Overlay([]byte(`{"t":"agent_status","state":"` + s + `","id":"q1"}`))
		if string(line) != `{"op":"overlay","id":"q1","kind":"clear","state":"`+s+`"}` {
			t.Fatalf("%s: %s", s, line)
		}
	}
	// writing carries the answer block: where the nib hands over to
	line, _ = Overlay([]byte(`{"t":"agent_status","state":"writing","id":"q1","agent":"agentd","bbox":[-400,3000,200,3200.004],"ts":1}`))
	if string(line) != `{"op":"overlay","id":"q1","kind":"clear","state":"writing","bbox":[-400,3000,200,3200]}` {
		t.Fatalf("writing: %s", line)
	}
	for in, want := range map[string]string{
		`{"t":"dock_action","id":"x"}`:                                          "not an agent_status",
		`{"t":"agent_status","state":"thinking","id":""}`:                       "id must be",
		`{"t":"agent_status","state":"sleeping","id":"q"}`:                      "state must be",
		`{"t":"agent_status","state":"thinking","id":"q","bbox":[1,2,3]}`:       "bbox must be",
		`{"t":"agent_status","state":"thinking","id":"q","bbox":[0,0,1,90000]}`: "off the page",
		`{"t":"agent_status","state":"thinking","id":"q","bbox":[10,0,1,1]}`:    "bbox must be",
	} {
		if line, why := Overlay([]byte(in)); line != nil || !strings.Contains(why, want) {
			t.Fatalf("%s: %s %q", in, line, why)
		}
	}
}
