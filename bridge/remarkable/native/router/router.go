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
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	sendQueue    = 1024             // messages buffered per client before it counts as stalled
	pingEvery    = 10 * time.Second // server → client keepalive
	pongWait     = 30 * time.Second // drop a client silent for this long
	writeWait    = 5 * time.Second
	replayPts    = 256 // points per replayed stroke_pts message
	maxStrokes   = 4000
	maxPoints    = 400_000 // page memory bound (~20 MB worst case); oldest strokes go first
	maxMessage   = 1 << 20
	docCompactAt = 256 // doc_update log entries before asking a client for a snapshot
	docReplayN   = 256 // updates per replayed doc_update message
)

// Router holds the sessions. The zero value is not usable; call New.
type Router struct {
	mu       sync.Mutex
	sessions map[string]*session
	upgrader websocket.Upgrader
	Logf     func(format string, args ...any)
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
	s := r.session(id)
	c := &client{conn: conn, send: make(chan []byte, sendQueue), addr: req.RemoteAddr}
	// Register and queue hello + replay under the session lock, so no live message can slip
	// in between the replay and the first broadcast this client sees.
	s.mu.Lock()
	c.queue(mustJSON(map[string]string{"t": "hello", "session": id}))
	for _, m := range s.replayLocked() {
		c.queue(m)
	}
	s.clients[c] = true
	n := len(s.clients)
	s.mu.Unlock()
	r.Logf("[router] %s joined %s (%d clients)", c.addr, id, n)

	go c.writeLoop()
	r.readLoop(s, c)

	s.mu.Lock()
	delete(s.clients, c)
	if s.compactWho == c {
		s.compactWho = nil // ask someone else next time
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
			s.recordLocked(m, raw)
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
			if len(s.docLog) > docCompactAt && s.compactWho == nil {
				s.compactWho, s.compactFrom = c, len(s.docLog)
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
	docLog      []string
	compactWho  *client // asked for a doc_state, or nil
	compactFrom int     // docLog length when it was asked
}

type stroke struct {
	begin []byte            // the stroke_begin message as received
	pts   []json.RawMessage // every point, as received
	ended bool
}

func (s *session) recordLocked(m envelope, raw []byte) {
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
		s.strokes[m.ID] = &stroke{begin: append([]byte(nil), raw...)}
	case "stroke_pts":
		st := s.strokes[m.ID]
		if st == nil {
			return // points for a stroke that began before a clear or before we started
		}
		st.pts = append(st.pts, m.Pts...)
		s.points += len(m.Pts)
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

// replayLocked renders the page as the messages a client would have seen live.
func (s *session) replayLocked() [][]byte {
	var out [][]byte
	for _, id := range s.order {
		st := s.strokes[id]
		if st == nil {
			continue
		}
		out = append(out, st.begin)
		for i := 0; i < len(st.pts); i += replayPts {
			j := min(i+replayPts, len(st.pts))
			out = append(out, mustJSON(struct {
				T   string            `json:"t"`
				ID  string            `json:"id"`
				Pts []json.RawMessage `json:"pts"`
			}{"stroke_pts", id, st.pts[i:j]}))
		}
		if st.ended {
			out = append(out, mustJSON(map[string]string{"t": "stroke_end", "id": id}))
		}
	}
	for i := 0; i < len(s.docLog); i += docReplayN {
		j := min(i+docReplayN, len(s.docLog))
		out = append(out, mustJSON(struct {
			T  string   `json:"t"`
			Us []string `json:"us"`
		}{"doc_update", s.docLog[i:j]}))
	}
	return out
}

func (s *session) broadcastLocked(raw []byte, from *client) {
	msg := append([]byte(nil), raw...)
	for c := range s.clients {
		if c != from {
			c.queue(msg)
		}
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
