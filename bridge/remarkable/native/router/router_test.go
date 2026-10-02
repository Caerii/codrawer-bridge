package router

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func dial(t *testing.T, srv *httptest.Server, session string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/" + session
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if m := read(t, c); m["t"] != "hello" || m["session"] != session {
		t.Fatalf("want hello for %s, got %v", session, m)
	}
	return c
}

func send(t *testing.T, c *websocket.Conn, msg string) {
	t.Helper()
	if err := c.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func read(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, raw, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("bad json %q: %v", raw, err)
	}
	return m
}

// expectQuiet asserts nothing arrives within d (e.g. a message must not echo to its sender).
// A read timeout is permanent in gorilla/websocket: call it last on a connection.
func expectQuiet(t *testing.T, c *websocket.Conn, d time.Duration) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(d))
	if _, raw, err := c.ReadMessage(); err == nil {
		t.Fatalf("expected nothing, got %s", raw)
	}
}

func newServer(t *testing.T) *httptest.Server {
	r := New()
	r.Logf = func(string, ...any) {}
	srv := httptest.NewServer(r.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func TestRelaysToOthersNotSender(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	glasses := dial(t, srv, "s1")
	other := dial(t, srv, "s2")

	send(t, tablet, `{"t":"stroke_begin","id":"u_1","layer":"user","brush":"pen","ts":1}`)
	send(t, tablet, `{"t":"stroke_pts","id":"u_1","pts":[[0.1,0.2,0.5,2],[0.11,0.21,0.5,3]]}`)
	send(t, tablet, `{"t":"key","key":"a","char":"a"}`)

	if m := read(t, glasses); m["t"] != "stroke_begin" || m["brush"] != "pen" {
		t.Fatalf("begin: %v", m)
	}
	if m := read(t, glasses); m["t"] != "stroke_pts" || len(m["pts"].([]any)) != 2 {
		t.Fatalf("pts: %v", m)
	}
	if m := read(t, glasses); m["t"] != "key" || m["char"] != "a" {
		t.Fatalf("key: %v", m)
	}
	expectQuiet(t, tablet, 150*time.Millisecond)
	expectQuiet(t, other, 150*time.Millisecond)
}

func TestLateJoinerGetsPageReplay(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	watcher := dial(t, srv, "s1") // a live client, used to know the router has processed the strokes

	send(t, tablet, `{"t":"stroke_begin","id":"u_1","brush":"pen"}`)
	pts := make([]string, 300) // more than one replay chunk
	for i := range pts {
		pts[i] = `[0.5,0.5,0.5,1]`
	}
	send(t, tablet, `{"t":"stroke_pts","id":"u_1","pts":[`+strings.Join(pts, ",")+`]}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_1"}`)
	send(t, tablet, `{"t":"stroke_begin","id":"u_2","brush":"pen"}`) // still being drawn
	for range 4 {
		read(t, watcher)
	}

	late := dial(t, srv, "s1")
	got := []string{}
	n := 0
	for range 5 {
		m := read(t, late)
		got = append(got, m["t"].(string)+":"+m["id"].(string))
		if m["t"] == "stroke_pts" {
			n += len(m["pts"].([]any))
		}
	}
	want := "stroke_begin:u_1 stroke_pts:u_1 stroke_pts:u_1 stroke_end:u_1 stroke_begin:u_2"
	if strings.Join(got, " ") != want {
		t.Fatalf("replay order\n got %s\nwant %s", strings.Join(got, " "), want)
	}
	if n != 300 {
		t.Fatalf("replayed %d points, want 300", n)
	}

	// The open stroke keeps streaming to the late joiner.
	send(t, tablet, `{"t":"stroke_pts","id":"u_2","pts":[[0.2,0.2,0.4,9]]}`)
	if m := read(t, late); m["t"] != "stroke_pts" || m["id"] != "u_2" {
		t.Fatalf("live after replay: %v", m)
	}
}

func TestClearWipesReplay(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	glasses := dial(t, srv, "s1")

	send(t, tablet, `{"t":"stroke_begin","id":"u_1"}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_1"}`)
	read(t, glasses)
	read(t, glasses)
	send(t, glasses, `{"t":"clear","ts":5}`)
	if m := read(t, tablet); m["t"] != "clear" {
		t.Fatalf("clear not relayed: %v", m)
	}

	late := dial(t, srv, "s1")
	expectQuiet(t, late, 150*time.Millisecond)
}

func TestTermGetsStatusAndAIIsDropped(t *testing.T) {
	srv := newServer(t)
	app := dial(t, srv, "s1")
	tablet := dial(t, srv, "s1")

	send(t, app, `{"t":"prompt","text":"draw a cat","mode":"draw"}`)
	send(t, app, `{"t":"term_prompt","text":"hi"}`)
	if m := read(t, app); m["t"] != "term" || m["kind"] != "status" {
		t.Fatalf("term status: %v", m)
	}
	expectQuiet(t, tablet, 150*time.Millisecond)
}

func TestDocUpdatesRelayReplayAndCompact(t *testing.T) {
	srv := newServer(t)
	a := dial(t, srv, "s1")
	b := dial(t, srv, "s1")

	// Relay to the others, not back to the sender.
	send(t, a, `{"t":"doc_update","u":"AAA="}`)
	if m := read(t, b); m["t"] != "doc_update" || m["u"] != "AAA=" {
		t.Fatalf("relay: %v", m)
	}

	// Grow the log past docCompactAt: the writer is asked for a snapshot exactly once.
	for range docCompactAt {
		send(t, a, `{"t":"doc_update","u":"BBB="}`)
		read(t, b)
	}
	if m := read(t, a); m["t"] != "doc_compact" {
		t.Fatalf("want doc_compact, got %v", m)
	}
	send(t, b, `{"t":"doc_update","u":"LATE"}`) // arrives after the request; must survive
	if m := read(t, a); m["u"] != "LATE" {
		t.Fatalf("late relay: %v", m)
	}
	send(t, a, `{"t":"doc_state","u":"SNAP"}`)
	send(t, a, `{"t":"doc_update","u":"AFTER"}`)
	if m := read(t, b); m["u"] != "AFTER" {
		t.Fatalf("after relay: %v", m)
	}

	// A joiner gets the compacted log: snapshot, then what came after the request.
	c := dial(t, srv, "s1")
	m := read(t, c)
	us, _ := m["us"].([]any)
	got := []string{}
	for _, u := range us {
		got = append(got, u.(string))
	}
	if m["t"] != "doc_update" || strings.Join(got, ",") != "SNAP,LATE,AFTER" {
		t.Fatalf("replay after compaction: %v", m)
	}
	expectQuiet(t, a, 100*time.Millisecond) // never echoed its own updates, asked only once
}

func TestDocSurvivesClear(t *testing.T) {
	srv := newServer(t)
	a := dial(t, srv, "s1")
	b := dial(t, srv, "s1")
	send(t, a, `{"t":"doc_update","u":"AAA="}`)
	read(t, b)
	send(t, a, `{"t":"clear"}`)
	read(t, b)
	c := dial(t, srv, "s1")
	if m := read(t, c); m["t"] != "doc_update" {
		t.Fatalf("doc lost on clear: %v", m)
	}
}

func TestBigPageReplayDoesNotDropJoiner(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	watcher := dial(t, srv, "s1")
	const strokes = 600 // 1800 replay messages, well past sendQueue
	// The watcher drains while the tablet sends (a live client keeps up); it also tells us when
	// the router has processed everything.
	drained := make(chan error, 1)
	go func() {
		for range strokes * 3 {
			if _, _, err := watcher.ReadMessage(); err != nil {
				drained <- err
				return
			}
		}
		drained <- nil
	}()
	for i := range strokes {
		id := "u_" + string(rune('a'+i%26)) + strings.Repeat("x", i/26)
		send(t, tablet, `{"t":"stroke_begin","id":"`+id+`"}`)
		send(t, tablet, `{"t":"stroke_pts","id":"`+id+`","pts":[[0.5,0.5,0.5,1]]}`)
		send(t, tablet, `{"t":"stroke_end","id":"`+id+`"}`)
	}
	if err := <-drained; err != nil {
		t.Fatalf("watcher: %v", err)
	}
	late := dial(t, srv, "s1")
	for i := range strokes * 3 {
		if m := read(t, late); m["t"] == nil {
			t.Fatalf("replay message %d malformed", i)
		}
	}
}

func TestHelloSaysReplayAndSourceCanSkipIt(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	watcher := dial(t, srv, "s1")
	send(t, tablet, `{"t":"stroke_begin","id":"u_1"}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_1"}`)
	read(t, watcher)
	read(t, watcher)

	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/s1"
	src, _, err := websocket.DefaultDialer.Dial(base+"?replay=0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if m := read(t, src); m["t"] != "hello" || m["replay"] != false {
		t.Fatalf("hello for a source: %v", m)
	}

	v, _, err := websocket.DefaultDialer.Dial(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer v.Close()
	if m := read(t, v); m["replay"] != true {
		t.Fatalf("hello for a viewer: %v", m)
	}
	if m := read(t, v); m["t"] != "stroke_begin" {
		t.Fatalf("viewer replay: %v", m)
	}
	expectQuiet(t, src, 150*time.Millisecond) // the pen source got no page replay
}

func TestLeavingMidStrokeEndsItForEveryone(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	glasses := dial(t, srv, "s1")
	send(t, tablet, `{"t":"stroke_begin","id":"u_1"}`)
	read(t, glasses)
	_ = tablet.Close() // the bridge's socket dies mid-stroke
	if m := read(t, glasses); m["t"] != "stroke_end" || m["id"] != "u_1" {
		t.Fatalf("want synthetic stroke_end, got %v", m)
	}
	late := dial(t, srv, "s1")
	read(t, late) // stroke_begin
	if m := read(t, late); m["t"] != "stroke_end" {
		t.Fatalf("replayed stroke still open: %v", m)
	}
}

func TestLiveMessagesDuringReplayKeepOrder(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	watcher := dial(t, srv, "s1")
	const page = 400
	for i := range page {
		id := fmt.Sprintf("u_%d", i)
		send(t, tablet, `{"t":"stroke_begin","id":"`+id+`"}`)
		send(t, tablet, `{"t":"stroke_end","id":"`+id+`"}`)
	}
	for range page * 2 {
		read(t, watcher)
	}
	// Join while the tablet keeps drawing: nothing replayed may arrive after a live message.
	const live = 50
	done := make(chan struct{})
	go func() {
		for i := range live {
			_ = tablet.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf(`{"t":"stroke_begin","id":"live_%d"}`, i)))
		}
		close(done)
	}()
	late := dial(t, srv, "s1")
	<-done
	nLive, nReplayed := 0, 0
	for range page*2 + live {
		m := read(t, late)
		id := m["id"].(string)
		if strings.HasPrefix(id, "live_") {
			nLive++
			continue
		}
		if nLive > 0 {
			t.Fatalf("replayed %s after a live message", id)
		}
		nReplayed++
	}
	if nReplayed != page*2 || nLive != live {
		t.Fatalf("replayed=%d live=%d", nReplayed, nLive)
	}
}
