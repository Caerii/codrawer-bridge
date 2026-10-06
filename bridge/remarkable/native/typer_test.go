package main

// The typer (typer.go): the write plan of each speed, the characters xochitl drops, the settle
// after Enter, the starting settings, and typer_config requests and acknowledgements, including
// through the bridge's typerLink. Linux-only package: see input_test.go for running these from
// Windows.

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"codrawer-bridge-native/pen"
)

const ms12 = 12 * time.Millisecond

func flatten(bs []burst) []inputEvent {
	var out []inputEvent
	for _, b := range bs {
		out = append(out, b.events...)
	}
	return out
}

func keysPerBurst(bs []burst) []int {
	var out []int
	for _, b := range bs {
		out = append(out, len(b.events)/4) // unshifted keys: 4 events each
	}
	return out
}

func TestPlanCarefulIsOneKeystrokePerWrite(t *testing.T) {
	p := plan("aB", presetSettings(speedCareful))
	if len(p) != 2 {
		t.Fatalf("bursts = %d, want 2", len(p))
	}
	want := []inputEvent{{pen.EvKey, KEY_LEFTSHIFT, 1}, {pen.EvKey, 48, 1}, {pen.EvSyn, pen.SynReport, 0}, {pen.EvKey, 48, 0}, {pen.EvKey, KEY_LEFTSHIFT, 0}, {pen.EvSyn, pen.SynReport, 0}}
	if !reflect.DeepEqual(p[1].events, want) {
		t.Fatalf("B = %v, want %v", p[1].events, want)
	}
	for _, b := range p {
		if b.pause != ms12 {
			t.Fatalf("pause %v", b.pause)
		}
	}
}

func TestPlanFastKeepsEveryFrameAndSettlesAfterEnter(t *testing.T) {
	text := "hello world\nok"
	p := plan(text, presetSettings(speedFast))
	if len(p) != 3 { // "hello ", "world\n", "ok"
		t.Fatalf("bursts = %d, want 3", len(p))
	}
	if p[0].pause != ms12 || p[1].pause != typeEnterMsDef*time.Millisecond || p[2].pause != ms12 {
		t.Fatalf("pauses %v %v %v", p[0].pause, p[1].pause, p[2].pause)
	}
	if !reflect.DeepEqual(flatten(p), flatten(plan(text, presetSettings(speedCareful)))) {
		t.Fatal("fast changed the event stream")
	}
	syns := 0
	for _, e := range flatten(p) {
		if e.etype == pen.EvSyn {
			syns++
		}
	}
	if syns != 2*len(text) {
		t.Fatalf("SYNs = %d, want one per press and per release (%d)", syns, 2*len(text))
	}
}

func TestPlanSplitsLongWords(t *testing.T) {
	if got := keysPerBurst(plan(strings.Repeat("x", 40), presetSettings(speedFast))); !reflect.DeepEqual(got, []int{typeWordMax, typeWordMax, 8}) {
		t.Fatalf("sizes = %v", got)
	}
}

func TestPlanInstantBurstsNeverCrossAnEnter(t *testing.T) {
	text := "ab cd ef gh\nij kl"
	s := presetSettings(speedInstant)
	s.Burst = 5
	p := plan(text, s)
	if got := keysPerBurst(p); !reflect.DeepEqual(got, []int{5, 5, 2, 5}) { // "ab cd", " ef g", "h\n", "ij kl"
		t.Fatalf("sizes = %v", got)
	}
	if p[0].pause != 40*time.Millisecond || p[2].pause != typeEnterMsDef*time.Millisecond {
		t.Fatalf("pauses %v %v", p[0].pause, p[2].pause)
	}
	if !reflect.DeepEqual(flatten(p), flatten(plan(text, presetSettings(speedCareful)))) {
		t.Fatal("instant changed the event stream")
	}
}

func TestPlanLeavesOutWhatXochitlDrops(t *testing.T) {
	if got := untypable("a^[b]{c}`~d\\|"); got != "^[]{}`~" {
		t.Fatalf("untypable = %q", got)
	}
	c := presetSettings(speedCareful)
	if !reflect.DeepEqual(flatten(plan("a{b}~", c)), flatten(plan("ab", c))) {
		t.Fatal("dropped characters were typed")
	}
}

func TestEnterSettleNeverShortensThePause(t *testing.T) {
	s := presetSettings(speedCareful)
	s.CharMs, s.EnterMs = 300, 150
	if p := plan("\n", s); p[0].pause != 300*time.Millisecond {
		t.Fatalf("pause %v", p[0].pause)
	}
	s = presetSettings(speedCareful)
	s.EnterMs = 0
	if p := plan("\n", s); p[0].pause != ms12 {
		t.Fatalf("pause %v", p[0].pause)
	}
}

func TestTyperSettingsFromEnv(t *testing.T) {
	cases := []struct {
		speed, batch           string
		charMs, burst, enterMs int
		want                   typerSettings
	}{
		{"", "", 0, 0, -1, presetSettings(speedCareful)},
		{"", " Word ", 0, 0, -1, presetSettings(speedFast)},
		{"instant", "word", 0, 0, -1, presetSettings(speedInstant)},
		{"bogus", "", 8, 99, 0, typerSettings{speedCareful, 8, typeBurstMax, 0}},
	}
	for _, c := range cases {
		if got := typerSettingsFromEnv(c.speed, c.batch, c.charMs, c.burst, c.enterMs); got != c.want {
			t.Fatalf("%+v: got %+v", c, got)
		}
	}
}

func decode(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestTyperConfigSetsSpeedAndAcknowledges(t *testing.T) {
	s := presetSettings(speedCareful)
	ack, ok := applyTyperConfig([]byte(`{"t":"typer_config","speed":"fast"}`), &s)
	if !ok || s != presetSettings(speedFast) {
		t.Fatalf("fast: %v %+v", ok, s)
	}
	want := map[string]any{"t": "typer_config", "speed": "fast", "char_ms": 12.0, "burst": 10.0, "enter_ms": 150.0, "ok": true}
	if got := decode(t, ack); !reflect.DeepEqual(got, want) {
		t.Fatalf("ack %v", got)
	}
	applyTyperConfig([]byte(`{"t":"typer_config","speed":"instant","char_ms":15,"burst":8,"enter_ms":300}`), &s)
	if s != (typerSettings{speedInstant, 15, 8, 300}) {
		t.Fatalf("instant: %+v", s)
	}
	applyTyperConfig([]byte(`{"t":"typer_config","speed":"careful"}`), &s)
	if s != (typerSettings{speedCareful, 12, 8, 300}) {
		t.Fatalf("a speed resets the pause only: %+v", s)
	}
	applyTyperConfig([]byte(`{"t":"typer_config","char_ms":20}`), &s)
	if s.Speed != speedCareful || s.CharMs != 20 {
		t.Fatalf("char_ms alone: %+v", s)
	}
}

func TestTyperConfigQueryRefusalsAndAcks(t *testing.T) {
	s := presetSettings(speedFast)
	if q, ok := applyTyperConfig([]byte(`{"t":"typer_config"}`), &s); !ok || decode(t, q)["speed"] != "fast" {
		t.Fatalf("query: %s", q)
	}
	for _, bad := range []string{
		`{"t":"typer_config","speed":"warp"}`,
		`{"t":"typer_config","char_ms":0}`,
		`{"t":"typer_config","speed":"instant","burst":17}`,
		`{"t":"typer_config","enter_ms":-1}`,
	} {
		a, ok := applyTyperConfig([]byte(bad), &s)
		m := decode(t, a)
		if !ok || m["ok"] != false || m["error"] == nil || s != presetSettings(speedFast) {
			t.Fatalf("%s: %v %v %+v", bad, ok, m, s)
		}
	}
	for _, not := range []string{`{"t":"typer_config","speed":"careful","ok":true}`, `{"t":"term","kind":"text","text":"x"}`, `nope`} {
		if _, ok := applyTyperConfig([]byte(not), &s); ok || s != presetSettings(speedFast) {
			t.Fatalf("%s was taken for a request", not)
		}
	}
}

func TestTyperLinkRoutesRepliesAndConfig(t *testing.T) {
	l := newTyperLink(presetSettings(speedCareful))
	if decode(t, l.announcement())["speed"] != "careful" {
		t.Fatal("announcement")
	}
	l.onMessage([]byte(`{"t":"typer_config","speed":"instant"}`))
	select {
	case ack := <-l.control():
		if m := decode(t, ack); m["speed"] != "instant" || m["ok"] != true {
			t.Fatalf("ack %v", m)
		}
	default:
		t.Fatal("no acknowledgement")
	}
	if l.shared.get() != presetSettings(speedInstant) {
		t.Fatal("not applied")
	}
	l.onMessage([]byte(`{"t":"term","kind":"text","text":"hi"}`))
	if got := <-l.replies; got != "hi" {
		t.Fatalf("reply %q", got)
	}
	l.dockAction([]byte(`{"t":"dock_action","id":"typer_fast","page":"p","source":"dock"}`))
	if ack := <-l.control(); decode(t, ack)["speed"] != "fast" || l.shared.get().Speed != speedFast {
		t.Fatalf("dock tap: %s", ack)
	}
	for _, not := range []string{`{"t":"dock_action","id":"ask_page"}`, `{"t":"dock_action","id":"typer_warp"}`, `{"t":"key","id":"typer_fast"}`} {
		if _, ok := dockRequest([]byte(not)); ok {
			t.Fatalf("%s taken for a dock speed tap", not)
		}
	}
	var none *typerLink // TYPE_REPLIES off
	none.dockAction([]byte(`{"t":"dock_action","id":"typer_fast"}`))
	none.onMessage([]byte(`{"t":"typer_config"}`))
	if none.announcement() != nil || none.control() != nil {
		t.Fatal("a nil link announces nothing")
	}
}
