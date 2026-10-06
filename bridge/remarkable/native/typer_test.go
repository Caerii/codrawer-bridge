package main

// The typer (typer.go): the write plan of each speed, the keymaps from xochitl's tables, the
// settle after Enter, priming, the pen and touch gate, the starting settings, and typer_config
// requests and acknowledgements, including through the bridge's typerLink. Linux-only package:
// see input_test.go for running these from Windows.

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"codrawer-bridge-native/pen"
)

const ms12 = 12 * time.Millisecond

var usTable = keymapNamed("UnitedStates")

func planUS(s string, how typerSettings) []burst {
	b, _ := plan(s, how, usTable)
	return b
}

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
	p := planUS("aB", presetSettings(speedCareful))
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
	p := planUS(text, presetSettings(speedFast))
	if len(p) != 3 { // "hello ", "world\n", "ok"
		t.Fatalf("bursts = %d, want 3", len(p))
	}
	if p[0].pause != ms12 || p[1].pause != typeEnterMsDef*time.Millisecond || p[2].pause != ms12 {
		t.Fatalf("pauses %v %v %v", p[0].pause, p[1].pause, p[2].pause)
	}
	if !reflect.DeepEqual(flatten(p), flatten(planUS(text, presetSettings(speedCareful)))) {
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
	if got := keysPerBurst(planUS(strings.Repeat("x", 40), presetSettings(speedFast))); !reflect.DeepEqual(got, []int{typeWordMax, typeWordMax, 8}) {
		t.Fatalf("sizes = %v", got)
	}
}

func TestPlanInstantBurstsNeverCrossAnEnter(t *testing.T) {
	text := "ab cd ef gh\nij kl"
	s := presetSettings(speedInstant)
	s.Burst = 5
	p := planUS(text, s)
	if got := keysPerBurst(p); !reflect.DeepEqual(got, []int{5, 5, 2, 5}) { // "ab cd", " ef g", "h\n", "ij kl"
		t.Fatalf("sizes = %v", got)
	}
	if p[0].pause != 40*time.Millisecond || p[2].pause != typeEnterMsDef*time.Millisecond {
		t.Fatalf("pauses %v %v", p[0].pause, p[2].pause)
	}
	if !reflect.DeepEqual(flatten(p), flatten(planUS(text, presetSettings(speedCareful)))) {
		t.Fatal("instant changed the event stream")
	}
}

func TestEnterSettleNeverShortensThePause(t *testing.T) {
	s := presetSettings(speedCareful)
	s.CharMs, s.EnterMs = 300, 150
	if p := planUS("\n", s); p[0].pause != 300*time.Millisecond {
		t.Fatalf("pause %v", p[0].pause)
	}
	s = presetSettings(speedCareful)
	s.EnterMs = 0
	if p := planUS("\n", s); p[0].pause != ms12 {
		t.Fatalf("pause %v", p[0].pause)
	}
}

func TestUSTableNeverPressesADeadKeyAndReportsDrops(t *testing.T) {
	if usTable.Missing != "[]^`{}~" {
		t.Fatalf("missing %q", usTable.Missing)
	}
	keys, dropped := typerKeystrokes("a[i] = x^2 {ok} `~|\\", usTable, false)
	if dropped != "[]^{}`~" {
		t.Fatalf("dropped %q", dropped)
	}
	hasBar := 0
	for _, k := range keys {
		if k.code == 26 || k.code == 27 || (k.code == 7 && k.mods == modShift) {
			t.Fatalf("dead key %v", k)
		}
		if k.code == 43 {
			hasBar++
		}
	}
	if hasBar != 2 {
		t.Fatal(`\ and | are typeable`)
	}
	if _, kept := typerKeystrokes("x^2 [a]", usTable, true); kept != "" {
		t.Fatalf("substitution left out %q", kept)
	}
	if sub, _ := typerKeystrokes("^", usTable, true); !reflect.DeepEqual(sub, []typerKey{{9, modShift}, {9, modShift}}) {
		t.Fatalf("^ → %v", sub)
	}
	if typo, d := typerKeystrokes("a—b…“c”", usTable, false); d != "" || len(typo) != 9 {
		t.Fatalf("typography %v %q", typo, d)
	}
}

func TestTablesFollowTheKeyboardLanguage(t *testing.T) {
	for in, want := range map[string]string{"": "UnitedStates", "en_US": "UnitedStates", "en_GB": "UnitedKingdom", "de_DE": "Germany", "nb_NO": "Norway"} {
		if got := tableForLocale(in); got != want {
			t.Fatalf("%q → %s", in, got)
		}
	}
	if inputLocale("[General]\nInputFlavor=1\nInputLocale=en_GB\n") != "en_GB" || inputLocale("[General]\n") != "" {
		t.Fatal("InputLocale")
	}
	uk := keymapNamed("UnitedKingdom")
	if _, d := typerKeystrokes("[a]{b}", uk, false); d != "" || uk.Missing != "^`~" {
		t.Fatalf("UK %q %q", d, uk.Missing)
	}
	de, _ := typerKeystrokes("@", keymapNamed("Germany"), false)
	if de[0].mods != modAltGr || keystrokeFrames(de[0], nil)[0] != (inputEvent{pen.EvKey, KEY_RIGHTALT, 1}) {
		t.Fatalf("German @ %v", de)
	}
	if keymapNamed("Klingon").Name != "UnitedStates" {
		t.Fatal("fallback table")
	}
}

func TestGateHoldsWhileThePenIsNearOrAFingerIsDown(t *testing.T) {
	g := newGate()
	if g.waitAt(10_000) != 0 {
		t.Fatal("idle")
	}
	g.penAt(pen.EvKey, pen.BtnToolPen, 1, 10_000)
	if g.waitAt(10_100) == 0 {
		t.Fatal("pen in range")
	}
	g.penAt(pen.EvKey, pen.BtnToolPen, 0, 10_200)
	if w := g.waitAt(10_300); w != 200*time.Millisecond {
		t.Fatalf("300 ms after the pen left: %v", w)
	}
	g.touchAt(pen.EvAbs, absMtSlot, 1, 11_000)
	g.touchAt(pen.EvAbs, absMtTrackingID, 7, 11_000)
	if g.waitAt(12_000) == 0 {
		t.Fatal("finger down")
	}
	g.touchAt(pen.EvAbs, absMtTrackingID, -1, 12_000)
	if g.waitAt(12_300) != 0 {
		t.Fatal("lifted 300 ms ago")
	}
	a := g.activityCount()
	g.penAt(pen.EvAbs, 0, 5, 13_000)
	if g.activityCount() == a {
		t.Fatal("activity")
	}
}

func TestPrimePressesEndAndWaits(t *testing.T) {
	p := primeBurst()
	want := []inputEvent{{pen.EvKey, keyEnd, 1}, {pen.EvSyn, pen.SynReport, 0}, {pen.EvKey, keyEnd, 0}, {pen.EvSyn, pen.SynReport, 0}}
	if !reflect.DeepEqual(p.events, want) || p.pause != typePrimeMs*time.Millisecond {
		t.Fatalf("prime %v", p)
	}
	if findTouchscreen([]inputDeviceInfo{{name: "Elan marker input", handlers: []string{"event2"}}, {name: "Elan touch input", handlers: []string{"event3"}}}) != "/dev/input/event3" {
		t.Fatal("touchscreen")
	}
}

func TestTyperSettingsFromEnv(t *testing.T) {
	cases := []struct {
		speed, batch           string
		charMs, burst, enterMs int
		sub                    bool
		want                   typerSettings
	}{
		{"", "", 0, 0, -1, false, presetSettings(speedCareful)},
		{"", " Word ", 0, 0, -1, false, presetSettings(speedFast)},
		{"instant", "word", 0, 0, -1, false, presetSettings(speedInstant)},
		{"bogus", "", 8, 99, 0, true, typerSettings{speedCareful, 8, typeBurstMax, 0, true}},
	}
	for _, c := range cases {
		if got := typerSettingsFromEnv(c.speed, c.batch, c.charMs, c.burst, c.enterMs, c.sub); got != c.want {
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
	ack, ok := applyTyperConfig([]byte(`{"t":"typer_config","speed":"fast"}`), &s, usTable)
	if !ok || s != presetSettings(speedFast) {
		t.Fatalf("fast: %v %+v", ok, s)
	}
	want := map[string]any{"t": "typer_config", "speed": "fast", "char_ms": 12.0, "burst": 10.0, "enter_ms": 150.0, "substitute": false, "keymap": "UnitedStates", "untypeable": "[]^`{}~", "ok": true}
	if got := decode(t, ack); !reflect.DeepEqual(got, want) {
		t.Fatalf("ack %v", got)
	}
	applyTyperConfig([]byte(`{"t":"typer_config","speed":"instant","char_ms":15,"burst":8,"enter_ms":300,"substitute":true}`), &s, usTable)
	if s != (typerSettings{speedInstant, 15, 8, 300, true}) {
		t.Fatalf("instant: %+v", s)
	}
	applyTyperConfig([]byte(`{"t":"typer_config","speed":"careful"}`), &s, usTable)
	if s != (typerSettings{speedCareful, 12, 8, 300, true}) {
		t.Fatalf("a speed resets the pause only: %+v", s)
	}
	applyTyperConfig([]byte(`{"t":"typer_config","char_ms":20}`), &s, usTable)
	if s.Speed != speedCareful || s.CharMs != 20 {
		t.Fatalf("char_ms alone: %+v", s)
	}
}

func TestTyperConfigQueryRefusalsAndAcks(t *testing.T) {
	s := presetSettings(speedFast)
	if q, ok := applyTyperConfig([]byte(`{"t":"typer_config"}`), &s, usTable); !ok || decode(t, q)["speed"] != "fast" {
		t.Fatalf("query: %s", q)
	}
	for _, bad := range []string{
		`{"t":"typer_config","speed":"warp"}`,
		`{"t":"typer_config","char_ms":0}`,
		`{"t":"typer_config","speed":"instant","burst":17}`,
		`{"t":"typer_config","enter_ms":-1}`,
	} {
		a, ok := applyTyperConfig([]byte(bad), &s, usTable)
		m := decode(t, a)
		if !ok || m["ok"] != false || m["error"] == nil || s != presetSettings(speedFast) {
			t.Fatalf("%s: %v %v %+v", bad, ok, m, s)
		}
	}
	for _, not := range []string{`{"t":"typer_config","speed":"careful","ok":true}`, `{"t":"term","kind":"text","text":"x"}`, `nope`} {
		if _, ok := applyTyperConfig([]byte(not), &s, usTable); ok || s != presetSettings(speedFast) {
			t.Fatalf("%s was taken for a request", not)
		}
	}
	if m := decode(t, typerNote("[]", usTable)); m["t"] != "typer_note" || m["dropped"] != "[]" || m["count"] != 2.0 {
		t.Fatalf("note %v", m)
	}
}

func TestTyperLinkRoutesRepliesAndConfig(t *testing.T) {
	l := newTyperLink(&sharedTyper{s: presetSettings(speedCareful), keymap: usTable})
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
