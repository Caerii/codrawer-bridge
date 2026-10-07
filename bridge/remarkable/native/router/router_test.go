package router

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
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

// typer_config: a request is relayed (to the bridge) but not kept; the bridge's acknowledgement
// is relayed and kept, survives clear, and a late joiner gets the latest one.
func TestTyperConfigRelaysAndLatestAckReplays(t *testing.T) {
	srv := newServer(t)
	phone := dial(t, srv, "s1")
	bridge := dial(t, srv, "s1")
	send(t, phone, `{"t":"typer_config","speed":"fast"}`)
	if m := read(t, bridge); m["t"] != "typer_config" || m["speed"] != "fast" || m["ok"] != nil {
		t.Fatalf("request relay: %v", m)
	}
	send(t, bridge, `{"t":"typer_config","speed":"careful","ok":true}`)
	read(t, phone)
	send(t, bridge, `{"t":"typer_config","speed":"fast","ok":true}`)
	if m := read(t, phone); m["speed"] != "fast" || m["ok"] != true {
		t.Fatalf("ack relay: %v", m)
	}
	send(t, bridge, `{"t":"typer_config","speed":"warp","ok":false}`) // a refusal is not the setting
	read(t, phone)
	send(t, phone, `{"t":"clear"}`)
	read(t, bridge)
	late := dial(t, srv, "s1")
	if m := read(t, late); m["t"] != "typer_config" || m["speed"] != "fast" || m["ok"] != true {
		t.Fatalf("replay: %v", m)
	}
	expectQuiet(t, late, 100*time.Millisecond) // the request itself was never kept
}

func TestBigPageReplayDoesNotDropJoiner(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	watcher := dial(t, srv, "s1")
	const strokes = 600 // 1800 replay messages, well past sendQueue
	// The watcher drains while the tablet sends (a live client keeps up); it also tells us when
	// the router has processed everything.
	// The tablet waits for the watcher every 100 strokes so a slow CI machine never lets the
	// watcher's backlog reach the stalled-client limit.
	drained := make(chan error, 1)
	var seen atomic.Int64
	go func() {
		for range strokes * 3 {
			if _, _, err := watcher.ReadMessage(); err != nil {
				drained <- err
				return
			}
			seen.Add(1)
		}
		drained <- nil
	}()
	for i := range strokes {
		id := "u_" + string(rune('a'+i%26)) + strings.Repeat("x", i/26)
		send(t, tablet, `{"t":"stroke_begin","id":"`+id+`"}`)
		send(t, tablet, `{"t":"stroke_pts","id":"`+id+`","pts":[[0.5,0.5,0.5,1]]}`)
		send(t, tablet, `{"t":"stroke_end","id":"`+id+`"}`)
		if (i+1)%100 == 0 {
			deadline := time.Now().Add(5 * time.Second)
			for seen.Load() < int64((i+1)*3) && time.Now().Before(deadline) {
				time.Sleep(2 * time.Millisecond)
			}
		}
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

func TestHelloCarriesHostInfo(t *testing.T) {
	r := New()
	r.Logf = func(string, ...any) {}
	r.Info = map[string]string{"os": "6.1.0", "osChangedFrom": "6.0.105", "version": "v8"}
	srv := httptest.NewServer(r.Handler())
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/s1", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	m := read(t, c)
	tab, _ := m["tablet"].(map[string]any)
	if tab["os"] != "6.1.0" || tab["osChangedFrom"] != "6.0.105" || tab["version"] != "v8" {
		t.Fatalf("hello: %v", m)
	}
}

func TestPairingCodeRequiredOffMachine(t *testing.T) {
	r := New()
	r.Logf = func(string, ...any) {}
	r.Token = "K7Q2-M9TX"
	srv := httptest.NewServer(r.Handler())
	t.Cleanup(srv.Close)
	base := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws/s1"

	// httptest listens on loopback, which is exempt; pretend to be a remote client through a
	// handler that rewrites RemoteAddr.
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		req.RemoteAddr = "192.168.50.165:50000"
		r.Handler().ServeHTTP(w, req)
	}))
	t.Cleanup(remote.Close)
	rbase := "ws" + strings.TrimPrefix(remote.URL, "http") + "/ws/s1"

	// remote without the code: told why, then closed with 4401
	c, _, err := websocket.DefaultDialer.Dial(rbase, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := read(t, c); m["t"] != "error" || m["code"] != "unauthorized" {
		t.Fatalf("want unauthorized, got %v", m)
	}
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = c.ReadMessage()
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != 4401 {
		t.Fatalf("want close 4401, got %v", err)
	}

	// remote with the wrong code: refused; with the right one (query or header): joins
	if c2, _, err := websocket.DefaultDialer.Dial(rbase+"?token=nope", nil); err == nil {
		if m := read(t, c2); m["code"] != "unauthorized" {
			t.Fatalf("wrong code joined: %v", m)
		}
	}
	ok, _, err := websocket.DefaultDialer.Dial(rbase+"?token=K7Q2-M9TX", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := read(t, ok); m["t"] != "hello" {
		t.Fatalf("right code: %v", m)
	}
	h := http.Header{"Authorization": {"Bearer K7Q2-M9TX"}}
	hc, _, err := websocket.DefaultDialer.Dial(rbase, h)
	if err != nil {
		t.Fatal(err)
	}
	if m := read(t, hc); m["t"] != "hello" {
		t.Fatalf("bearer: %v", m)
	}

	// loopback (the pen bridge on the tablet) needs no code
	lc, _, err := websocket.DefaultDialer.Dial(base, nil)
	if err != nil {
		t.Fatal(err)
	}
	if m := read(t, lc); m["t"] != "hello" {
		t.Fatalf("loopback: %v", m)
	}
}

func TestPageSnapshotIsTheNewBase(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	viewer := dial(t, srv, "s1")

	// u_old: drawn before the save (in the file, or erased); u_new: drawn after it
	send(t, tablet, `{"t":"stroke_begin","id":"u_old","ts":1000}`)
	send(t, tablet, `{"t":"stroke_pts","id":"u_old","pts":[[0.1,0.1,0.5,1000]]}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_old","ts":1100}`)
	send(t, tablet, `{"t":"stroke_begin","id":"u_new","ts":3000}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_new","ts":3100}`)
	page := `{"t":"page","doc":"d","page":"p1","rev":2000,"strokes":[{"id":"1:5","tool":"fineliner","pts":[[0.1,0.1,0.5,0.002]]}]}`
	send(t, tablet, page)
	for range 5 {
		read(t, viewer)
	}
	if m := read(t, viewer); m["t"] != "page" || m["page"] != "p1" {
		t.Fatalf("page not relayed: %v", m)
	}

	late := dial(t, srv, "s1")
	got := []string{}
	for range 3 {
		m := read(t, late)
		id, _ := m["id"].(string)
		got = append(got, m["t"].(string)+":"+id)
	}
	if want := "page: stroke_begin:u_new stroke_end:u_new"; strings.Join(got, " ") != want {
		t.Fatalf("replay\n got %s\nwant %s", strings.Join(got, " "), want)
	}

	// a page turn replaces the base; ink from before the turn is gone from the replay
	send(t, tablet, `{"t":"page","doc":"d","page":"p2","rev":4000,"strokes":[]}`)
	read(t, viewer)
	late2 := dial(t, srv, "s1")
	if m := read(t, late2); m["t"] != "page" || m["page"] != "p2" {
		t.Fatalf("turn: %v", m)
	}
	expectQuiet(t, late2, 150*time.Millisecond)

	// a pen source (?replay=0) gets no page either
	src, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws/s1?replay=0", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	if m := read(t, src); m["t"] != "hello" {
		t.Fatalf("hello: %v", m)
	}
	expectQuiet(t, src, 150*time.Millisecond)
}

func TestClearDropsThePage(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	viewer := dial(t, srv, "s1")
	send(t, tablet, `{"t":"page","doc":"d","page":"p1","rev":5,"strokes":[]}`)
	read(t, viewer)
	send(t, viewer, `{"t":"clear","ts":6}`)
	read(t, tablet)
	expectQuiet(t, dial(t, srv, "s1"), 150*time.Millisecond)
}

func TestBigPageMessageIsAccepted(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	viewer := dial(t, srv, "s1")
	pts := strings.Repeat(`[0.12345,0.12345,0.5,0.0025],`, 60000) // ~1.7 MB
	send(t, tablet, `{"t":"page","doc":"d","page":"p","rev":1,"strokes":[{"id":"1:1","pts":[`+pts+`[0,0,0,0]]}]}`)
	_ = viewer.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, raw, err := viewer.ReadMessage()
	if err != nil || len(raw) < 1<<20 {
		t.Fatalf("big page: %d bytes, %v", len(raw), err)
	}
}

func TestPageSnapshotKeepsOtherParticipantsStrokes(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	peer := dial(t, srv, "s1")
	// the tablet user draws, then a peer draws on its own layer
	send(t, tablet, `{"t":"stroke_begin","id":"u_1","layer":"user","ts":100}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_1"}`)
	send(t, peer, `{"t":"stroke_begin","id":"p_1","layer":"peer","color":"#d6482a","ts":150}`)
	send(t, peer, `{"t":"stroke_end","id":"p_1"}`)
	read(t, tablet) // p_1 begin
	read(t, tablet) // p_1 end
	// the tablet saves its page (covers u_1); the peer's stroke is in no file and must stay
	send(t, tablet, `{"t":"page","doc":"d","page":"p","rev":200,"strokes":[]}`)
	read(t, peer) // u_1 begin
	read(t, peer) // u_1 end
	read(t, peer) // page
	late := dial(t, srv, "s1")
	if m := read(t, late); m["t"] != "page" {
		t.Fatalf("want the page first, got %v", m)
	}
	m := read(t, late)
	if m["t"] != "stroke_begin" || m["id"] != "p_1" {
		t.Fatalf("peer stroke dropped by the snapshot: %v", m)
	}
}

// A peer's strokes belong to the page they were drawn on: when the tablet turns to another page
// (or document), they leave the replay, or a late joiner would see them painted onto the new page.
func TestPageTurnDropsOtherParticipantsStrokes(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	peer := dial(t, srv, "s1")
	send(t, tablet, `{"t":"page","doc":"d","page":"p1","rev":100,"strokes":[]}`)
	read(t, peer) // page p1
	send(t, peer, `{"t":"stroke_begin","id":"p_1","layer":"peer","color":"#d6482a","ts":150}`)
	send(t, peer, `{"t":"stroke_end","id":"p_1"}`)
	read(t, tablet) // p_1 begin
	read(t, tablet) // p_1 end
	send(t, tablet, `{"t":"page","doc":"d","page":"p2","rev":200,"strokes":[]}`)
	read(t, peer) // page p2
	late := dial(t, srv, "s1")
	if m := read(t, late); m["t"] != "page" || m["page"] != "p2" {
		t.Fatalf("want page p2 first, got %v", m)
	}
	expectQuiet(t, late, 300*time.Millisecond)
}

// stroke_delete: the owner's delete reaches everyone and the stroke leaves the replay, so a late
// joiner never sees it; ai-layer ink may be taken back by anyone; unknown ids are dropped.
func TestLateJoinerDoesNotGetDeletedStrokes(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	agent := dial(t, srv, "s1")
	send(t, tablet, `{"t":"stroke_begin","id":"u_1","layer":"user","ts":1}`)
	send(t, tablet, `{"t":"stroke_pts","id":"u_1","pts":[[0.1,0.1,0.5,2]]}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_1"}`)
	send(t, tablet, `{"t":"stroke_begin","id":"u_2","layer":"user","ts":3}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_2"}`)
	for range 5 {
		read(t, agent)
	}
	send(t, agent, `{"t":"stroke_begin","id":"ai_1","layer":"ai","ts":4}`)
	send(t, agent, `{"t":"stroke_end","id":"ai_1"}`)
	read(t, tablet)
	read(t, tablet)

	send(t, tablet, `{"t":"stroke_delete","ids":["u_1","ai_1","nope"],"ts":5}`)
	if m := read(t, agent); m["t"] != "stroke_delete" || fmt.Sprint(m["ids"]) != "[u_1 ai_1]" {
		t.Fatalf("want the accepted ids relayed, got %v", m)
	}

	late := dial(t, srv, "s1")
	if m := read(t, late); m["t"] != "stroke_begin" || m["id"] != "u_2" {
		t.Fatalf("want only u_2 replayed, got %v", m)
	}
	if m := read(t, late); m["t"] != "stroke_end" || m["id"] != "u_2" {
		t.Fatalf("want u_2's end, got %v", m)
	}
	expectQuiet(t, late, 150*time.Millisecond)
}

// A participant may not delete someone else's user ink: nothing is relayed and the stroke stays
// in the replay.
func TestNonOwnerCannotDeleteUserInk(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	peer := dial(t, srv, "s1")
	send(t, tablet, `{"t":"stroke_begin","id":"u_1","layer":"user","ts":1}`)
	send(t, tablet, `{"t":"stroke_end","id":"u_1"}`)
	read(t, peer)
	read(t, peer)
	send(t, peer, `{"t":"stroke_delete","ids":["u_1"],"ts":2}`)
	send(t, peer, `{"t":"key","key":"a","char":"a"}`) // a marker: the delete was handled before it
	if m := read(t, tablet); m["t"] != "key" {
		t.Fatalf("a refused delete was relayed: %v", m)
	}
	late := dial(t, srv, "s1")
	if m := read(t, late); m["t"] != "stroke_begin" || m["id"] != "u_1" {
		t.Fatalf("the refused delete removed u_1 anyway: %v", m)
	}
}

// Personal marks (protocol.md, "Personal marks") are relayed to the others, never back.
func TestMarksMessagesAreRelayed(t *testing.T) {
	srv := newServer(t)
	phone := dial(t, srv, "s1")
	other := dial(t, srv, "s1")
	for _, m := range []string{
		`{"t":"mark_ask","ask":"ma_1","owner":"p1","items":[],"options":["tag"],"ts":1}`,
		`{"t":"mark_define","op":"create","by":"p1","meaning":{"action":"tag","params":{"tag":"idea"}},"ts":2}`,
		`{"t":"mark_invoke","invocation":"iv_1","mark":"mk_1","owner":"p1","mode":"notify","ts":3}`,
		`{"t":"mark_feedback","invocation":"iv_1","verdict":"undo","by":"p1","via":"phone","ts":4}`,
		`{"t":"mark_query","by":"p2"}`,
		`{"t":"marks","owner":"p1","marks":[],"ts":5}`,
		`{"t":"mark_seen","occurrence":"oc_1","owner":"p1","strokes":[],"bbox":[0,0,1,1],"result":"candidate","why":"","ts":6}`,
	} {
		send(t, phone, m)
	}
	for _, want := range []string{"mark_ask", "mark_define", "mark_invoke", "mark_feedback", "mark_query", "marks", "mark_seen"} {
		if m := read(t, other); m["t"] != want {
			t.Fatalf("want %s, got %v", want, m)
		}
	}
	expectQuiet(t, phone, 150*time.Millisecond)
}

// "Take me there" (protocol.md, "goto") reaches the tablet bridge as sent; the bridge decides
// whether it navigates or becomes an offer.
func TestGotoIsRelayed(t *testing.T) {
	srv := newServer(t)
	phone := dial(t, srv, "s1")
	tablet := dial(t, srv, "s1")
	send(t, phone, `{"t":"goto","doc":"4c0e2d44-91ad-4d94-a473-ac8187400cd7","page":"3","origin":"user"}`)
	if m := read(t, tablet); m["t"] != "goto" || m["origin"] != "user" || m["page"] != "3" {
		t.Fatalf("got %v", m)
	}
	expectQuiet(t, phone, 150*time.Millisecond)
}

// An agent's settings (protocol.md, "settings") and a phone's change to them are relayed as sent.
func TestSettingsAreRelayed(t *testing.T) {
	srv := newServer(t)
	agent := dial(t, srv, "s1")
	phone := dial(t, srv, "s1")
	send(t, agent, `{"t":"settings","owner":"agentd","values":{"text_size":"medium","spacing":"compact"}}`)
	if m := read(t, phone); m["t"] != "settings" || m["owner"] != "agentd" {
		t.Fatalf("got %v", m)
	}
	send(t, phone, `{"t":"settings","owner":"agentd","set":{"text_size":"large"}}`)
	if m := read(t, agent); m["t"] != "settings" || m["set"] == nil {
		t.Fatalf("got %v", m)
	}
	expectQuiet(t, phone, 150*time.Millisecond)
}

// An agent's dock entries are relayed; when the agent leaves, the router withdraws them for it
// (an empty list per owner it announced), so the tablet's dock never keeps a dead agent's rows.
// An owner the agent withdrew itself is not withdrawn again.
func TestDockEntriesWithdrawnWhenOwnerLeaves(t *testing.T) {
	srv := newServer(t)
	tablet := dial(t, srv, "s1")
	agent := dial(t, srv, "s1")
	send(t, agent, `{"t":"dock_entries","owner":"agentd","entries":[{"id":"agentd_memory","label":"Memory: off","badge":"off"}]}`)
	if m := read(t, tablet); m["t"] != "dock_entries" || m["owner"] != "agentd" {
		t.Fatalf("got %v", m)
	}
	send(t, agent, `{"t":"dock_entries","owner":"other","entries":[{"id":"x","label":"X"}]}`)
	read(t, tablet)
	send(t, agent, `{"t":"dock_entries","owner":"other","entries":[]}`)
	read(t, tablet)
	_ = agent.Close()
	m := read(t, tablet)
	if m["t"] != "dock_entries" || m["owner"] != "agentd" {
		t.Fatalf("want agentd's entries withdrawn, got %v", m)
	}
	if e, ok := m["entries"].([]any); !ok || len(e) != 0 {
		t.Fatalf("want an empty list, got %v", m["entries"])
	}
	expectQuiet(t, tablet, 150*time.Millisecond) // "other" was withdrawn already
}
