// Package router is the stroke-only session router (docs/protocol.md), small enough to run on
// the Paper Pro inside the bridge binary (-serve) so the glasses app can connect to the tablet
// directly, with no desktop in the loop (ADR 007: the session is the composition point, and every
// surface is an optional peer of it).
//
// # Scope
//
// It relays hello, stroke_*, key, cursor, clear, page, doc, and shared live editing
// (doc_update/doc_state). AI (prompt, ai_*) and the terminal (term_prompt/term_answer) stay on
// the desktop Python router; here AI messages are dropped, and a term_* request gets a one-line
// `term` status so the client is not left waiting.
//
// # What it adds to the Python router, and why
//
//   - A client that joins mid-drawing gets the current page replayed: the tablet's latest saved
//     `page`, then every live stroke recorded since (begin/pts/end), then the shared document.
//     Opening the glasses app shows what is already on the page.
//   - The tablet's saved page ({"t":"page"}, the bridge's page watcher, ADR 008) is the page's
//     base. The router keeps the latest, drops recorded tablet strokes that began before its rev
//     (they are in it, or were erased), and replays it before the strokes recorded after it.
//   - Every client has its own bounded send queue. A client that falls behind (a phone on bad
//     Wi-Fi) is dropped and reconnects to a fresh replay, instead of slowing the tablet's stream
//     for everyone.
//   - A replay is built outside the session lock; live messages for that client are held until
//     its replay is queued, so ordering is exact and a big page never freezes the stream.
//   - The router pings clients and drops ones that stop answering (a phone that left Wi-Fi).
//     Besides WebSocket pings it sends {"t":"ping"}, which browsers can see, so the glasses app
//     can detect a half-open socket on its side. hello carries "replay":true|false.
//   - A pen source joins with ?replay=0 (the bridge does: it has no use for the page). When a
//     client leaves mid-stroke, its open strokes are ended for everyone.
//   - Off-machine clients can be required to present a pairing code (Router.Token).
//
// # Reading order
//
// router.go (this file: limits, Router, authorisation) → conn.go (the life of one connection:
// join, replay, read, leave) → dispatch.go (what each message type does) → session.go (the
// recorded page and the page base) → replay.go (snapshot → messages) → docsync.go (the shared
// document log and its compaction) → client.go (per-client queue and writer).
package router

import (
	"crypto/subtle"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Limits and timings. Memory bounds matter: the router runs on the tablet next to xochitl.
const (
	sendQueue       = 1024             // messages buffered per client (beyond its replay) before it counts as stalled
	pingEvery       = 10 * time.Second // server → client keepalive
	pongWait        = 30 * time.Second // drop a client silent for this long
	writeWait       = 5 * time.Second  // per-message write deadline
	replayPts       = 256              // points per replayed stroke_pts message
	maxStrokes      = 4000             // recorded strokes per session; oldest go first
	maxPoints       = 150_000          // recorded points per session (~90 B/point, ~14 MB); oldest strokes go first
	maxStrokePoints = 20_000           // one stroke never records more (a pen resting on the glass)
	maxMessage      = 16 << 20         // a `page` snapshot of a dense page is a few MB

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

// New returns a router with no sessions, logging through log.Printf.
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

// Handler serves /healthz ({"ok":true}, polled by boot.sh's health check) and /ws/{session}.
func (r *Router) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/ws/", r.serveWS)
	return mux
}

// session returns the session with this id, creating it on first use. Sessions live for the
// process: the page must survive every client leaving and coming back.
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

// ── pairing ─────────────────────────────────────────────────────────────────

// authorized reports whether a request may join: no Token set, a loopback peer, or the right
// token (compared in constant time).
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

// refuse tells an upgraded but unauthorised client why, closes with 4401 and logs it. The
// upgrade happens first because a browser cannot read an HTTP error from a WebSocket handshake.
func (r *Router) refuse(conn *websocket.Conn, req *http.Request) {
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"error","code":"unauthorized","text":"pairing code required"}`))
	_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4401, "unauthorized"))
	_ = conn.Close()
	r.Logf("[router] %s refused: missing or wrong pairing code", req.RemoteAddr)
}
