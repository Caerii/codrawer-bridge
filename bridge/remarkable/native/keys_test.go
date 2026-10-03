package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

func fixedNow() int64 { return 1_730_000_000_123 }

func TestKeyDecoder(t *testing.T) {
	var d keyDecoder
	type step struct {
		code  uint16
		value int32
		want  string // JSON of the message, "" for none
	}
	steps := []step{
		{30, 1, `{"t":"key","key":"a","char":"a","code":30,"repeat":false,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`},
		{30, 0, ""}, // key-up
		{KEY_LEFTSHIFT, 1, ""},
		{30, 2, `{"t":"key","key":"A","char":"A","code":30,"repeat":true,"mods":{"shift":true,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`},
		{KEY_LEFTSHIFT, 0, ""},
		{KEY_CAPSLOCK, 1, ""},
		{KEY_CAPSLOCK, 0, ""},
		{30, 1, `{"t":"key","key":"A","char":"A","code":30,"repeat":false,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`},
		{2, 1, `{"t":"key","key":"1","char":"1","code":2,"repeat":false,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`}, // caps: letters only
		{57, 1, `{"t":"key","key":"Space","char":" ","code":57,"repeat":false,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`},
		{KEY_LEFTCTRL, 1, ""},
		{46, 1, `{"t":"key","key":"C","code":46,"repeat":false,"mods":{"shift":false,"ctrl":true,"alt":false,"meta":false},"ts":1730000000123}`}, // chord: no char
		{KEY_LEFTCTRL, 0, ""},
		{28, 1, `{"t":"key","key":"Enter","code":28,"repeat":false,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`},
		{240, 1, `{"t":"key","key":"Unidentified(240)","code":240,"repeat":false,"mods":{"shift":false,"ctrl":false,"alt":false,"meta":false},"ts":1730000000123}`},
	}
	for i, s := range steps {
		k, ok := d.decode(s.code, s.value, fixedNow)
		got := ""
		if ok {
			b, _ := json.Marshal(k)
			got = string(b)
		}
		if got != s.want {
			t.Fatalf("step %d (code %d value %d):\n got %s\nwant %s", i, s.code, s.value, got, s.want)
		}
	}
}

func TestTypedReply(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{`{"t":"term","kind":"text","text":"hello"}`, "hello", true},
		{`{"t":"term","kind":"note","text":"— done —"}`, "\n— done —\n", true},
		{`{"t":"term","kind":"note","text":"> list the tests"}`, "", false}, // the prompt echo
		{`{"t":"term","kind":"permission","text":"Bash? y/n"}`, "\nBash? y/n\n", true},
		{`{"t":"term","kind":"question","text":"which?"}`, "\nwhich?\n", true},
		{`{"t":"term","kind":"status","text":"attached"}`, "", false},
		{`{"t":"stroke_end","id":"u_1"}`, "", false},
		{`not json`, "", false},
	}
	for _, c := range cases {
		got, ok := typedReply([]byte(c.in))
		if got != c.want || ok != c.ok {
			t.Errorf("typedReply(%s) = %q, %v; want %q, %v", c.in, got, ok, c.want, c.ok)
		}
	}
}

// typed is what a US layout produces for keystrokes ("⏎" for Enter, "⇥" for Tab).
func typed(ks []keystroke) string {
	s := ""
	for _, k := range ks {
		switch k.code {
		case keyEnter:
			s += "⏎"
		case keyTab:
			s += "⇥"
		default:
			pair := usKeymap[uint16(k.code)]
			if k.shift {
				s += pair[1]
			} else {
				s += pair[0]
			}
		}
	}
	return s
}

// Some characters are on two keys (number row and keypad: digits, - . / *), and which one
// charToKey picks depends on map order, so this compares what gets typed, not key codes.
func TestKeystrokes(t *testing.T) {
	got := typed(keystrokes("Hi! 1-2*3\r\n\t—“x”‘y’…é"))
	if want := `Hi! 1-2*3⏎⇥-"x"'y'...`; got != want { // é is not on a US layout: dropped
		t.Fatalf("typed %q, want %q", got, want)
	}
}

// Every character that has an unshifted key is typed without Shift.
func TestKeystrokesPreferUnshifted(t *testing.T) {
	for _, ks := range keystrokes("0123456789-./*+ ") {
		if ks.shift {
			t.Fatalf("typed with shift: %+v", ks)
		}
	}
}

func TestSourceURL(t *testing.T) {
	cases := map[string]string{
		"ws://127.0.0.1:8577/ws/session1":          "ws://127.0.0.1:8577/ws/session1?replay=0",
		"ws://h:1/ws/s?token=K7Q2":                 "ws://h:1/ws/s?replay=0&token=K7Q2",
		"ws://h:1/ws/s?replay=1":                   "ws://h:1/ws/s?replay=1",
		"ws://192.168.50.2:8577/ws/session1?x=1#f": "ws://192.168.50.2:8577/ws/session1?replay=0&x=1#f",
	}
	for in, want := range cases {
		if got := sourceURL(in); got != want {
			t.Errorf("sourceURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPageWatchEnabled(t *testing.T) {
	cases := []struct {
		mode, tested string
		want         bool
	}{
		{"auto", "1", true}, {"auto", "0", false}, {"auto", "", false},
		{"on", "0", true}, {" YES ", "", true}, {"off", "1", false}, {"0", "1", false},
		{"bogus", "1", true}, {"bogus", "0", false},
	}
	for _, c := range cases {
		if got := pageWatchEnabled(c.mode, c.tested); got != c.want {
			t.Errorf("pageWatchEnabled(%q, %q) = %v", c.mode, c.tested, got)
		}
	}
}

func TestPageSummary(t *testing.T) {
	in := `{"t":"page","doc":"d","page":"p","rev":5,"w":1620,"h":2160,"strokes":[{"id":"1:2"}]}`
	if got, want := pageSummary([]byte(in)), `{"t":"page","doc":"d","page":"p","rev":5,"w":1620,"h":2160}`; got != want {
		t.Fatalf("got %s", got)
	}
}

func TestHostInfo(t *testing.T) {
	env := map[string]string{"CODRAWER_OS": "3.29.0.149", "CODRAWER_OS_TESTED": "1", "CODRAWER_VERSION": ""}
	got := hostInfo(func(k string) string { return env[k] })
	want := map[string]string{"os": "3.29.0.149", "osTested": "1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
}
