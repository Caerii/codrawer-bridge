package router

// What each message type does.
//
// The router decodes only the envelope of a message (type, id, a few fields it acts on) and
// forwards the raw bytes unchanged, so fields it does not know (author, colour, participant ids)
// reach the other clients intact. A message is never echoed to its sender.
//
//	stroke_begin/pts/end   record for replay, relay
//	stroke_delete          forget the strokes the sender may delete, relay those ids
//	key, cursor, doc       relay
//	dock_action            relay (a tap in the tablet's injected dock, sent by the bridge)
//	typer_note             relay (what a typed reply lost, from the bridge)
//	typer_config           relay; the latest acknowledgement (ok:true, from the bridge) is kept
//	                       and replayed to joiners, so every client shows the current speed
//	clear                  forget the recorded page and the base, relay
//	page                   becomes the page's base (session.go), relay
//	doc_update             append to the document log, relay, maybe ask for compaction
//	doc_state              the compaction answer: replaces the log (docsync.go)
//	term_prompt/answer     answered with a `term` status: no terminal here
//	anything else          dropped (prompt, ai_*: AI is off on this router)

import (
	"encoding/json"
	"time"

	"github.com/gorilla/websocket"
)

// envelope is the part of a message the router looks at; the raw bytes are forwarded as-is.
type envelope struct {
	T   string            `json:"t"`
	ID  string            `json:"id"`  // stroke_*: the stroke id
	Pts []json.RawMessage `json:"pts"` // stroke_pts: points, kept raw
	U   string            `json:"u"`   // doc_update, doc_state: a base64 Yjs update
	Ts  int64             `json:"ts"`  // stroke_begin: when the stroke started (ms)
	// stroke_begin: "user" (the tablet's ink), "peer" (another participant), "ai"
	Layer string   `json:"layer"`
	IDs   []string `json:"ids"`  // stroke_delete: the strokes to remove
	Rev   int64    `json:"rev"`  // page: the snapshot covers everything up to this time (ms)
	Doc   string   `json:"doc"`  // page: the open document's id
	Page  string   `json:"page"` // page: the open page's id
	OK    *bool    `json:"ok"`   // typer_config: present on the bridge's acknowledgement
}

// strokeDelete is a stroke_delete re-encoded with only the ids the router accepted, when it
// refused or did not know some of those asked for.
type strokeDelete struct {
	T   string   `json:"t"`
	IDs []string `json:"ids"`
	Ts  int64    `json:"ts,omitempty"`
}

// termUnavailable answers term_* requests on this router.
var termUnavailable = map[string]string{
	"t": "term", "kind": "status", "text": "no terminal on this router (tablet-local; stroke streaming only)",
}

// readLoop reads c's messages until the connection fails or goes silent for pongWait. Any
// traffic, not only pongs, counts as alive.
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
		_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
		if kind != websocket.TextMessage {
			continue
		}
		var m envelope
		if json.Unmarshal(raw, &m) != nil {
			continue
		}
		s.dispatch(m, raw, c)
	}
}

// dispatch applies one message from c to the session.
func (s *session) dispatch(m envelope, raw []byte, c *client) {
	switch m.T {
	case "stroke_begin", "stroke_pts", "stroke_end":
		s.mu.Lock()
		s.recordLocked(m, raw, c)
		s.broadcastLocked(raw, c)
		s.mu.Unlock()
	case "stroke_delete":
		s.mu.Lock()
		if gone := s.deleteLocked(m.IDs, c); len(gone) == len(m.IDs) && len(gone) > 0 {
			s.broadcastLocked(raw, c) // every id stood: forward as sent, extra fields intact
		} else if len(gone) > 0 {
			s.broadcastLocked(mustJSON(strokeDelete{"stroke_delete", gone, m.Ts}), c)
		}
		s.mu.Unlock()
	case "key", "cursor", "doc", "typer_note",
		"primer", "primer_request", "dock_action", "dock_entries", "dock_query", "goto", "agent_status", // as sent (ADR 010; protocol.md)
		"mark_seen", "mark_ask", "mark_define", "mark_invoke", "mark_feedback", "mark_query", "marks": // personal marks (protocol.md)
		s.mu.Lock()
		s.broadcastLocked(raw, c)
		s.mu.Unlock()
	case "typer_config":
		s.mu.Lock()
		if m.OK != nil && *m.OK {
			s.typer = append([]byte(nil), raw...)
		}
		s.broadcastLocked(raw, c)
		s.mu.Unlock()
	case "clear":
		s.mu.Lock()
		s.resetLocked()
		s.page = nil
		s.broadcastLocked(raw, c)
		s.mu.Unlock()
	case "page":
		s.mu.Lock()
		s.setPageLocked(m, raw)
		s.broadcastLocked(raw, c)
		s.mu.Unlock()
	case "doc_update":
		if m.U == "" {
			return
		}
		s.mu.Lock()
		s.docUpdateLocked(m.U, raw, c)
		s.mu.Unlock()
	case "doc_state":
		s.mu.Lock()
		s.docStateLocked(m.U, c)
		s.mu.Unlock()
	case "term_prompt", "term_answer":
		c.queue(mustJSON(termUnavailable))
	}
}
