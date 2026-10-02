package router

import (
	"encoding/json"
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
