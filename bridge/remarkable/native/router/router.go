// Package router is the stroke-only session router (docs/protocol.md), small enough to run on
// the Paper Pro inside the bridge binary so the glasses app can connect to the tablet directly.
//
// Scope: hello, stroke_*, key, cursor, clear, doc, and shared live editing (doc_update). AI (prompt, ai_*) and the terminal
// (term_prompt/term_answer) stay on the desktop Python router; here they are dropped, and a
// term_* request gets a one-line `term` status so the client is not left waiting.
//
// Beyond the Python router:
//   - A client that joins mid-drawing gets the current page replayed (begin/pts/end per stroke),
//     so opening the glasses app shows what is already on the page.
//   - Every client has its own bounded send queue; a client that falls behind is dropped (it
//     reconnects and gets the replay) instead of stalling the tablet's stream.
//   - The router pings clients and drops ones that stop answering (a phone that left Wi-Fi).
//     Besides WebSocket pings it sends {"t":"ping"}, which browsers can see, so the glasses app
//     can detect a half-open socket on its side. hello carries "replay":true.
//   - A replay is built outside the session lock; live messages for that client are held
//     until its replay is queued, so a big page never freezes the stream for everyone else.
//   - A pen source can join with ?replay=0 (the bridge does). When a client leaves mid-stroke
//     its open strokes are ended for everyone.
//
// Shared live editing: clients keep the session document as a Yjs CRDT and send
// {"t":"doc_update","u":<base64>}. The router never decodes them; it relays each one, keeps the
// log and replays it to joiners as {"t":"doc_update","us":[...]}. When the log grows past
// docCompactAt it asks the client that just wrote for {"t":"doc_state","u":<full state>} and
// replaces the log with that state plus everything that arrived after the request. Nothing is
// lost: the client had received the whole log up to the request (same ordered queue), and
// updates are idempotent, so overlap is harmless.
package router

import (
	"crypto/subtle"
	"encoding/json"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	sendQueue       = 1024             // messages buffered per client before it counts as stalled
	pingEvery       = 10 * time.Second // server → client keepalive
	pongWait        = 30 * time.Second // drop a client silent for this long
	writeWait       = 5 * time.Second
	replayPts       = 256 // points per replayed stroke_pts message
	maxStrokes      = 4000
	maxPoints       = 150_000 // page memory bound (~90 B/point, ~14 MB); oldest strokes go first
	maxStrokePoints = 20_000  // one stroke never holds more (a pen resting on the glass)
	maxMessage      = 1 << 20
	docCompactAt    = 256              // doc_update log entries before asking a client for a snapshot
	docReplayN      = 256              // updates per replayed doc_update message
	docCompactAfter = 10 * time.Second // re-ask another writer if the asked one never answers
)

// Router holds the sessions. The zero value is not usable; call New.
type Router struct {
	mu       sync.Mutex
	sessions map[string]*session
	upgrader websocket.Upgrader
	Logf     func(format string, args ...any)
	// Info describes the host (e.g. the tablet's OS and codrawer versions); sent in hello as
	// "tablet" so clients can say "tablet updated" or show versions. Set before serving.
	Info map[string]string
	// Token, when set, is required from every client that is not on this machine: as ?token=
	// (browsers cannot set WebSocket headers) or "Authorization: Bearer". The pen bridge talks
	// over loopback and is exempt. A wrong or missing token gets {"t":"error","code":
	// "unauthorized"} and close code 4401, so an app can ask for the pairing code.
	Token string
}

// authorized reports whether a request may join.
func (r *Router) authorized(req *http.Request) bool {
	if r.Token == "" {
		return true
	}
	if host, _, err := net.SplitHostPort(req.RemoteAddr); err == nil {
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return true
		}
	}
	got := req.URL.Query().Get("token")
	if auth := req.Header.Get("Authorization"); got == "" && strings.HasPrefix(auth, "Bearer ") {
		got = strings.TrimPrefix(auth, "Bearer ")
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(r.Token)) == 1
}

func New() *Router {
	return &Router{
		sessions: map[string]*session{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  16 << 10,
			WriteBufferSize: 16 << 10,
			// The glasses app is served from the Even app or a dev server, never this origin.
			CheckOrigin: func(*http.Request) bool { return true },
		},
		Logf: log.Printf,
	}
}

// Handler serves /healthz and /ws/{session}.
func (r *Router) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/ws/", r.serveWS)
	return mux
}

func (r *Router) session(id string) *session {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.sessions[id]
	if s == nil {
		s = &session{id: id, clients: map[*client]bool{}, strokes: map[string]*stroke{}}
		r.sessions[id] = s
	}
	return s
}

func (r *Router) serveWS(w http.ResponseWriter, req *http.Request) {
	id := strings.Trim(strings.TrimPrefix(req.URL.Path, "/ws/"), "/")
	if id == "" || strings.Contains(id, "/") {
		http.NotFound(w, req)
		return
	}
	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		return // Upgrade already wrote the error response
	}
	if !r.authorized(req) {
		_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"error","code":"unauthorized","text":"pairing code required"}`))
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4401, "unauthorized"))
		_ = conn.Close()
		r.Logf("[router] %s refused: missing or wrong pairing code", req.RemoteAddr)
		return
	}
	s := r.session(id)
	wantReplay := req.URL.Query().Get("replay") != "0"
	// Register under the lock with a snapshot of the page; broadcasts to this client are held
	// (c.held) until the replay built from the snapshot is queued, so ordering is exact
	// without marshalling the page while everyone else waits on the lock.
	c := &client{conn: conn, addr: req.RemoteAddr, replaying: true}
	s.mu.Lock()
	var snap pageSnapshot
	if wantReplay {
		snap = s.snapshotLocked()
	}
	s.clients[c] = true
	n := len(s.clients)
	s.mu.Unlock()

	replay := snap.messages()
	// The queue holds the whole replay plus the usual headroom: a big page must not count as a
	// stalled client.
	c.send = make(chan []byte, len(replay)+1+sendQueue)
	hello := map[string]any{"t": "hello", "session": id, "replay": wantReplay}
	if len(r.Info) > 0 {
		hello["tablet"] = r.Info
	}
	c.queue(mustJSON(hello))
	for _, m := range replay {
		c.queue(m)
	}
	s.mu.Lock()
	for _, m := range c.held {
		c.queue(m)
	}
	c.held, c.replaying = nil, false
	s.mu.Unlock()
	r.Logf("[router] %s joined %s (%d clients, replayed %d messages)", c.addr, id, n, len(replay))

	go c.writeLoop()
	r.readLoop(s, c)

	s.mu.Lock()
	delete(s.clients, c)
	if s.compactWho == c {
		s.compactWho = nil // ask someone else next time
	}
	// Strokes this client was drawing will never get their stroke_end: end them for everyone.
	for id, st := range s.strokes {
		if st.owner == c && !st.ended {
			st.ended = true
			s.broadcastLocked(mustJSON(map[string]string{"t": "stroke_end", "id": id}), c)
		}
	}
	n = len(s.clients)
	s.mu.Unlock()
	c.close()
	r.Logf("[router] %s left %s (%d clients)", c.addr, id, n)
}

// envelope is the part of a message the router looks at; the raw bytes are forwarded as-is.
type envelope struct {
	T   string            `json:"t"`
	ID  string            `json:"id"`
	Pts []json.RawMessage `json:"pts"`
	U   string            `json:"u"`
}

func (r *Router) readLoop(s *session, c *client) {
	c.conn.SetReadLimit(maxMessage)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		kind, raw, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait)) // any traffic counts as alive
		if kind != websocket.TextMessage {
			continue
		}
		var m envelope
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		switch m.T {
		case "stroke_begin", "stroke_pts", "stroke_end":
			s.mu.Lock()
			s.recordLocked(m, raw, c)
			s.broadcastLocked(raw, c)
			s.mu.Unlock()
		case "key", "cursor", "doc":
			s.mu.Lock()
			s.broadcastLocked(raw, c)
			s.mu.Unlock()
		case "clear":
			s.mu.Lock()
			s.resetLocked()
			s.broadcastLocked(raw, c)
			s.mu.Unlock()
		case "doc_update":
			if m.U == "" {
				continue
			}
			s.mu.Lock()
			s.docLog = append(s.docLog, m.U)
			s.broadcastLocked(raw, c)
			stale := s.compactWho != nil && time.Since(s.compactAsked) > docCompactAfter
			if len(s.docLog) > docCompactAt && (s.compactWho == nil || stale) {
				// ask the client that just wrote: it is alive and holds the whole document
				s.compactWho, s.compactFrom, s.compactAsked = c, len(s.docLog), time.Now()
				c.queue([]byte(`{"t":"doc_compact"}`))
			}
			s.mu.Unlock()
		case "doc_state":
			s.mu.Lock()
			if m.U != "" && s.compactWho == c {
				s.docLog = append([]string{m.U}, s.docLog[s.compactFrom:]...)
				s.compactWho = nil
			}
			s.mu.Unlock()
		case "term_prompt", "term_answer":
			c.queue(mustJSON(map[string]string{
				"t": "term", "kind": "status", "text": "no terminal on this router (tablet-local; stroke streaming only)",
			}))
		}
		// prompt, ai_* and unknown types: dropped (AI is off on this router).
	}
}

// ── session ─────────────────────────────────────────────────────────────────

type session struct {
	id      string
	mu      sync.Mutex
	clients map[*client]bool
	// page: strokes since the last clear, in arrival order, for replay to late joiners.
	order   []string
	strokes map[string]*stroke
	points  int
	// shared document: Yjs updates (base64) in arrival order; survives clear (it is not ink)
	docLog       []string
	compactWho   *client   // asked for a doc_state, or nil
	compactFrom  int       // docLog length when it was asked
	compactAsked time.Time // when it was asked
}

type stroke struct {
	begin []byte            // the stroke_begin message as received
	pts   []json.RawMessage // every point, as received
	ended bool
	owner *client // who is drawing it (ended for everyone if they leave mid-stroke)
}

func (s *session) recordLocked(m envelope, raw []byte, from *client) {
	if m.ID == "" {
		return
	}
	switch m.T {
	case "stroke_begin":
		if old := s.strokes[m.ID]; old != nil {
			s.points -= len(old.pts)
		} else {
			s.order = append(s.order, m.ID)
		}
		s.strokes[m.ID] = &stroke{begin: append([]byte(nil), raw...), owner: from}
	case "stroke_pts":
		st := s.strokes[m.ID]
		if st == nil {
			return // points for a stroke that began before a clear or before we started
		}
		add := m.Pts
		if room := maxStrokePoints - len(st.pts); len(add) > room {
			add = add[:max(0, room)] // still relayed live; only the replay copy is capped
		}
		st.pts = append(st.pts, add...)
		s.points += len(add)
	case "stroke_end":
		if st := s.strokes[m.ID]; st != nil {
			st.ended = true
		}
	}
	for (len(s.order) > maxStrokes || s.points > maxPoints) && len(s.order) > 1 {
		oldest := s.order[0]
		s.order = s.order[1:]
		if st := s.strokes[oldest]; st != nil {
			s.points -= len(st.pts)
		}
		delete(s.strokes, oldest)
	}
}

func (s *session) resetLocked() {
	s.order = nil
	s.strokes = map[string]*stroke{}
	s.points = 0
}

// pageSnapshot is the page at one instant. It only copies slice headers: point slices are
// append-only and a re-begun stroke gets a new struct, so the elements it covers never change
// after the lock is released.
type pageSnapshot struct {
	strokes []strokeSnap
	doc     []string
}

type strokeSnap struct {
	id    string
	begin []byte
	pts   []json.RawMessage
	ended bool
}

func (s *session) snapshotLocked() pageSnapshot {
	snap := pageSnapshot{doc: s.docLog[:len(s.docLog):len(s.docLog)]}
	for _, id := range s.order {
		if st := s.strokes[id]; st != nil {
			snap.strokes = append(snap.strokes, strokeSnap{id, st.begin, st.pts[:len(st.pts):len(st.pts)], st.ended})
		}
	}
	return snap
}

// messages renders the snapshot as the messages a client would have seen live.
func (snap pageSnapshot) messages() [][]byte {
	var out [][]byte
	for _, st := range snap.strokes {
		out = append(out, st.begin)
		for i := 0; i < len(st.pts); i += replayPts {
			j := min(i+replayPts, len(st.pts))
			out = append(out, mustJSON(struct {
				T   string            `json:"t"`
				ID  string            `json:"id"`
				Pts []json.RawMessage `json:"pts"`
			}{"stroke_pts", st.id, st.pts[i:j]}))
		}
		if st.ended {
			out = append(out, mustJSON(map[string]string{"t": "stroke_end", "id": st.id}))
		}
	}
	for i := 0; i < len(snap.doc); i += docReplayN {
		j := min(i+docReplayN, len(snap.doc))
		out = append(out, mustJSON(struct {
			T  string   `json:"t"`
			Us []string `json:"us"`
		}{"doc_update", snap.doc[i:j]}))
	}
	return out
}

func (s *session) broadcastLocked(raw []byte, from *client) {
	msg := append([]byte(nil), raw...)
	for c := range s.clients {
		if c == from {
			continue
		}
		if c.replaying {
			c.held = append(c.held, msg) // guarded by s.mu; flushed once its replay is queued
			continue
		}
		c.queue(msg)
	}
}

// ── client ──────────────────────────────────────────────────────────────────

type client struct {
	conn     *websocket.Conn
	send     chan []byte
	addr     string
	once     sync.Once
	mu       sync.Mutex
	isClosed bool
	// replaying/held are guarded by the session's mutex, not c.mu
	replaying bool
	held      [][]byte
}

// queue never blocks: a client whose queue is full is closed (it will reconnect and replay).
func (c *client) queue(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.isClosed {
		return
	}
	select {
	case c.send <- msg:
	default:
		c.isClosed = true
		close(c.send)
	}
}

func (c *client) close() {
	c.mu.Lock()
	if !c.isClosed {
		c.isClosed = true
		close(c.send)
	}
	c.mu.Unlock()
	c.once.Do(func() { _ = c.conn.Close() })
}

func (c *client) writeLoop() {
	ping := time.NewTicker(pingEvery)
	defer func() {
		ping.Stop()
		c.once.Do(func() { _ = c.conn.Close() }) // unblocks the read loop
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "behind"))
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
			// browsers never surface protocol pings; this one lets the app see a live link
			if err := c.conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"ping"}`)); err != nil {
				return
			}
		}
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
