package main

// The main package builds only for Linux (golang.org/x/sys/unix, uinput). From Windows, run these
// tests in a container (README.md, "Tests"):
//
//	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go test -c -o main.test . && docker run --rm -v "$PWD:/w" alpine:3.20 /w/main.test

import (
	"encoding/binary"
	"reflect"
	"testing"

	"codrawer-bridge-native/pen"
)

// record encodes one 24-byte input_event (64-bit timeval).
func record(sec, usec int64, typ, code uint16, value int32) []byte {
	b := make([]byte, 24)
	binary.LittleEndian.PutUint64(b[0:], uint64(sec))
	binary.LittleEndian.PutUint64(b[8:], uint64(usec))
	binary.LittleEndian.PutUint16(b[16:], typ)
	binary.LittleEndian.PutUint16(b[18:], code)
	binary.LittleEndian.PutUint32(b[20:], uint32(value))
	return b
}

// Records split across reads are reassembled, and the caller may reuse its buffer.
func TestInputParserSplitsAndJoins(t *testing.T) {
	var stream []byte
	stream = append(stream, record(1_790_000_000, 123_456, pen.EvAbs, pen.AbsX, 500)...)
	stream = append(stream, record(1_790_000_000, 124_999, pen.EvAbs, pen.AbsPressure, -1)...)
	stream = append(stream, record(1_790_000_001, 0, pen.EvSyn, pen.SynReport, 0)...)

	var got []pen.Event
	p := &inputParser{}
	buf := make([]byte, 0, 64)
	for _, cut := range [][2]int{{0, 10}, {10, 40}, {40, 72}} {
		buf = append(buf[:0], stream[cut[0]:cut[1]]...)
		p.feed(buf, func(ev pen.Event) { got = append(got, ev) })
		for i := range buf {
			buf[i] = 0xEE // the parser must not keep pointing into it
		}
	}
	want := []pen.Event{
		{Type: pen.EvAbs, Code: pen.AbsX, Value: 500, TimeMS: 1_790_000_000_123},
		{Type: pen.EvAbs, Code: pen.AbsPressure, Value: -1, TimeMS: 1_790_000_000_124},
		{Type: pen.EvSyn, Code: pen.SynReport, Value: 0, TimeMS: 1_790_000_001_000},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestDecodeEvent16(t *testing.T) {
	b := make([]byte, 16)
	binary.LittleEndian.PutUint32(b[0:], 100)
	binary.LittleEndian.PutUint32(b[4:], 2_500)
	binary.LittleEndian.PutUint16(b[8:], pen.EvKey)
	binary.LittleEndian.PutUint16(b[10:], pen.BtnTouch)
	binary.LittleEndian.PutUint32(b[12:], 1)
	want := pen.Event{Type: pen.EvKey, Code: pen.BtnTouch, Value: 1, TimeMS: 100_002}
	if got := decodeEvent(b); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

// After SYN_DROPPED everything up to the next SYN_REPORT is discarded and replaced by the
// device's real state.
func TestResyncerReplacesDroppedEvents(t *testing.T) {
	var out []pen.Event
	emit := func(ev pen.Event) { out = append(out, ev) }
	state := func(ts int64) []pen.Event {
		return []pen.Event{{Type: pen.EvKey, Code: pen.BtnTouch, Value: 0, TimeMS: ts}, {Type: pen.EvSyn, Code: pen.SynReport, TimeMS: ts}}
	}
	var rs resyncer
	for _, ev := range []pen.Event{
		{Type: pen.EvAbs, Code: pen.AbsX, Value: 1, TimeMS: 1},
		{Type: pen.EvSyn, Code: pen.SynDropped, TimeMS: 2},
		{Type: pen.EvAbs, Code: pen.AbsX, Value: 2, TimeMS: 3}, // discarded
		{Type: pen.EvSyn, Code: pen.SynReport, TimeMS: 4},      // replaced by the device state
		{Type: pen.EvAbs, Code: pen.AbsY, Value: 9, TimeMS: 5},
	} {
		rs.handle(ev, emit, state)
	}
	want := []pen.Event{
		{Type: pen.EvAbs, Code: pen.AbsX, Value: 1, TimeMS: 1},
		{Type: pen.EvKey, Code: pen.BtnTouch, Value: 0, TimeMS: 4},
		{Type: pen.EvSyn, Code: pen.SynReport, TimeMS: 4},
		{Type: pen.EvAbs, Code: pen.AbsY, Value: 9, TimeMS: 5},
	}
	if !reflect.DeepEqual(out, want) {
		t.Fatalf("got %+v\nwant %+v", out, want)
	}
}

const procDevices = `I: Bus=0019 Vendor=0001 Product=0001 Version=0100
N: Name="30370000.snvs:snvs-powerkey"
H: Handlers=kbd event0

I: Bus=0018 Vendor=04f3 Product=2e1d Version=0100
N: Name="Elan marker input"
H: Handlers=event2

I: Bus=0006 Vendor=5349 Product=4742 Version=0001
N: Name="codrawer virtual keyboard"
H: Handlers=sysrq kbd event5

I: Bus=0005 Vendor=046d Product=b36f Version=0001
N: Name="Keys-To-Go 2"
H: Handlers=sysrq kbd leds event6

I: Bus=0005 Vendor=046d Product=b371 Version=0001
N: Name="Pebble Keyboard"
H: Handlers=sysrq kbd leds event7
`

func TestParseProcInputDevices(t *testing.T) {
	devs := parseProcInputDevices(procDevices)
	if len(devs) != 5 {
		t.Fatalf("%d devices", len(devs))
	}
	if d := devs[1]; d.name != "Elan marker input" || !reflect.DeepEqual(d.handlers, []string{"event2"}) || d.virtual {
		t.Fatalf("marker: %+v", d)
	}
	if !devs[2].virtual {
		t.Fatal("bus 0006 not marked virtual")
	}
}

// The power key and virtual keyboards are skipped; a name with "keyboard" beats an earlier kbd.
func TestPickKeyboard(t *testing.T) {
	devs := parseProcInputDevices(procDevices)
	if got := pickKeyboard(devs); got != "/dev/input/event7" {
		t.Fatalf("picked %q", got)
	}
	if got := pickKeyboard(devs[:4]); got != "/dev/input/event6" {
		t.Fatalf("fallback picked %q", got)
	}
	if got := pickKeyboard(devs[:3]); got != "" {
		t.Fatalf("picked %q from power key and virtual keyboard", got)
	}
}
