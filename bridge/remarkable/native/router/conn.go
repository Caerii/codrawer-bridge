package router

// The life of one connection.
//
//	upgrade → authorise → join (register + snapshot, under the lock)
//	        → queue hello + replay (outside the lock) → release held live messages (lock)
//	        → write loop (goroutine) + read loop (this goroutine) → leave
//
// The ordering problem: a joiner must see the page replay first and then every live message
// that arrived after the snapshot, with nothing lost or duplicated, but marshalling a big page
// under the session lock would stall the tablet's stream for everyone. So the client is
// registered with replaying=true in the same critical section that takes the snapshot; from then
// on broadcasts to it are appended to c.held instead of its queue. Once hello and the replay are
// queued, the held messages are queued under the lock and replaying is cleared, so every later
// broadcast goes straight to the queue behind them.

import (
	"net/http"
	"sort"
	"strings"

	"github.com/gorilla/websocket"
)

// serveWS runs one client connection from upgrade to leave.
func (r *Router) serveWS(w http.ResponseWriter, req *http.Request) {
	id, ok := sessionID(req.URL.Path)
	if !ok {
		http.NotFound(w, req)
		return
	}
	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		return // Upgrade already wrote the error response
	}
	if !r.authorized(req) {
		r.refuse(conn, req)
		return
	}
	s := r.session(id)
	wantReplay := req.URL.Query().Get("replay") != "0"

	c, snap, n := s.join(conn, req.RemoteAddr, wantReplay)
	replay := snap.messages()
	// The queue holds the whole replay plus the usual headroom: a big page must not count as a
	// stalled client.
	c.send = make(chan []byte, len(replay)+1+sendQueue)
	c.queue(r.hello(id, wantReplay))
	for _, m := range replay {
		c.queue(m)
	}
	s.releaseHeld(c)
	r.Logf("[router] %s joined %s (%d clients, replayed %d messages)", c.addr, id, n, len(replay))

	go c.writeLoop()
	r.readLoop(s, c)

	n = s.leave(c)
	c.close()
	r.Logf("[router] %s left %s (%d clients)", c.addr, id, n)
}

// sessionID extracts {session} from /ws/{session}; it must be one non-empty path segment.
func sessionID(path string) (string, bool) {
	id := strings.Trim(strings.TrimPrefix(path, "/ws/"), "/")
	if id == "" || strings.Contains(id, "/") {
		return "", false
	}
	return id, true
}

// hello is the first message on every connection: the session id, whether a replay follows, and
// the host's Info as "tablet" when set.
func (r *Router) hello(id string, replay bool) []byte {
	hello := map[string]any{"t": "hello", "session": id, "replay": replay}
	if len(r.Info) > 0 {
		hello["tablet"] = r.Info
	}
	return mustJSON(hello)
}

// join registers a new client in replaying state and, when it wants one, snapshots the page in
// the same critical section. It returns the client count including the new one.
func (s *session) join(conn *websocket.Conn, addr string, wantReplay bool) (*client, pageSnapshot, int) {
	c := &client{conn: conn, addr: addr, replaying: true}
	s.mu.Lock()
	defer s.mu.Unlock()
	var snap pageSnapshot
	if wantReplay {
		snap = s.snapshotLocked()
	}
	s.clients[c] = true
	return c, snap, len(s.clients)
}

// releaseHeld queues the live messages held during c's replay and ends the replay, under the
// lock so that no broadcast can slip in between.
func (s *session) releaseHeld(c *client) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range c.held {
		c.queue(m)
	}
	c.held, c.replaying = nil, false
}

// leave unregisters c. Strokes it was drawing will never get their stroke_end, so they are ended
// for everyone; if it was asked for a document snapshot, the next writer is asked instead; the
// dock entries it announced are withdrawn for it. It returns the remaining client count.
func (s *session) leave(c *client) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients, c)
	if s.compactWho == c {
		s.compactWho = nil // ask someone else next time
	}
	for id, st := range s.strokes {
		if st.owner == c && !st.ended {
			st.ended = true
			s.broadcastLocked(mustJSON(map[string]string{"t": "stroke_end", "id": id}), c)
		}
	}
	// Its dock entries go with it: the tablet's bridge drops them from dock.json, so the dock
	// never offers what nobody answers.
	owners := make([]string, 0, len(c.dockOwners))
	for o := range c.dockOwners {
		owners = append(owners, o)
	}
	sort.Strings(owners)
	for _, o := range owners {
		s.broadcastLocked(mustJSON(map[string]any{"t": "dock_entries", "owner": o, "entries": []any{}}), c)
	}
	return len(s.clients)
}
