package router

// The recorded page.
//
// A session remembers what a late joiner needs to see the page as everyone else does: the
// tablet's latest saved `page` (the base) and the live strokes recorded since, in arrival order.
// Strokes are kept as the messages they arrived as (the raw stroke_begin and raw points), so the
// replay is byte-for-byte what live clients saw, extra fields included.
//
// Memory is bounded (maxStrokes, maxPoints, maxStrokePoints): when a bound is exceeded the
// oldest strokes are forgotten, never the newest. Every method named …Locked expects s.mu held.

import (
	"encoding/json"
	"sync"
	"time"
)

// session is one codrawer session: its clients, its recorded page and its shared document.
type session struct {
	id      string
	mu      sync.Mutex
	clients map[*client]bool
	// page: the tablet's latest saved page (a `page` snapshot, or nil), then the live strokes
	// recorded after it, in arrival order, for replay to late joiners.
	page    []byte
	pageKey string   // "doc/page" of the latest snapshot ("" before the first)
	order   []string // stroke ids in arrival order
	strokes map[string]*stroke
	points  int // recorded points over all strokes
	// shared document: Yjs updates (base64) in arrival order; survives clear (it is not ink)
	docLog       []string
	compactWho   *client   // asked for a doc_state, or nil
	compactFrom  int       // docLog length when it was asked
	compactAsked time.Time // when it was asked
}

// stroke is one recorded live stroke.
type stroke struct {
	ts    int64             // stroke_begin's ts, ms (0 if it had none)
	begin []byte            // the stroke_begin message as received
	pts   []json.RawMessage // every point as received, up to maxStrokePoints
	ended bool
	owner *client // who is drawing it (ended for everyone if they leave mid-stroke)
	layer string  // from stroke_begin; "" or "user" is the tablet's own ink
}

// isTabletInk reports whether the stroke is the tablet user's own ink (and so belongs to the
// tablet's saved page), as opposed to another participant's or the AI's.
func (st *stroke) isTabletInk() bool { return st.layer == "" || st.layer == "user" }

// ── recording ───────────────────────────────────────────────────────────────

// recordLocked records one stroke_* message from `from`, then enforces the memory bounds.
// Messages without an id are relayed but not recorded.
func (s *session) recordLocked(m envelope, raw []byte, from *client) {
	if m.ID == "" {
		return
	}
	switch m.T {
	case "stroke_begin":
		s.beginLocked(m, raw, from)
	case "stroke_pts":
		if !s.pointsLocked(m) {
			return // nothing recorded, nothing to evict
		}
	case "stroke_end":
		if st := s.strokes[m.ID]; st != nil {
			st.ended = true
		}
	}
	s.evictLocked()
}

// beginLocked records a new stroke. A repeated id replaces the old stroke in place (keeping its
// position in the order) with a fresh struct, which snapshots taken earlier rely on.
func (s *session) beginLocked(m envelope, raw []byte, from *client) {
	if old := s.strokes[m.ID]; old != nil {
		s.points -= len(old.pts)
	} else {
		s.order = append(s.order, m.ID)
	}
	s.strokes[m.ID] = &stroke{ts: m.Ts, layer: m.Layer, begin: append([]byte(nil), raw...), owner: from}
}

// pointsLocked appends points to their stroke, up to maxStrokePoints. Points beyond the cap are
// still relayed live; only the replay copy is capped. Points for a stroke that began before a
// clear (or before the router started) are not recorded; it then returns false.
func (s *session) pointsLocked(m envelope) bool {
	st := s.strokes[m.ID]
	if st == nil {
		return false
	}
	add := m.Pts
	if room := maxStrokePoints - len(st.pts); len(add) > room {
		add = add[:max(0, room)]
	}
	st.pts = append(st.pts, add...)
	s.points += len(add)
	return true
}

// evictLocked forgets the oldest strokes until the session is within maxStrokes and maxPoints,
// always keeping at least the newest one.
func (s *session) evictLocked() {
	for (len(s.order) > maxStrokes || s.points > maxPoints) && len(s.order) > 1 {
		oldest := s.order[0]
		s.order = s.order[1:]
		if st := s.strokes[oldest]; st != nil {
			s.points -= len(st.pts)
		}
		delete(s.strokes, oldest)
	}
}

// resetLocked forgets every recorded stroke (clear). The caller drops the page base too.
func (s *session) resetLocked() {
	s.order = nil
	s.strokes = map[string]*stroke{}
	s.points = 0
}

// ── the page base ───────────────────────────────────────────────────────────

// setPageLocked makes a `page` snapshot the page's new base. The snapshot already holds every
// stroke the tablet saved up to its rev (erased ones are simply absent), so the live log keeps
// only strokes that began after rev: ink drawn since the save, not yet in any file. Strokes on
// other layers (other participants, AI) are never in the tablet's file: they stay while the page
// stays, and leave when the tablet turns to another page or document (they were drawn on the old
// one; replaying them would paint them onto the new page). Both times are on the tablet's clock
// (docs/protocol.md, `page`).
func (s *session) setPageLocked(m envelope, raw []byte) {
	s.page = append([]byte(nil), raw...)
	key := m.Doc + "/" + m.Page
	turned := s.pageKey != "" && s.pageKey != key
	s.pageKey = key
	order := s.order[:0:0]
	for _, id := range s.order {
		st := s.strokes[id]
		if st != nil && (st.isTabletInk() && st.ts > m.Rev || !st.isTabletInk() && !turned) {
			order = append(order, id)
			continue
		}
		if st != nil {
			s.points -= len(st.pts)
		}
		delete(s.strokes, id)
	}
	s.order = order
}

// ── fan-out ─────────────────────────────────────────────────────────────────

// broadcastLocked queues a copy of raw to every client but `from`. A client still receiving its
// replay gets it appended to c.held instead (conn.go), to be queued right after the replay.
func (s *session) broadcastLocked(raw []byte, from *client) {
	msg := append([]byte(nil), raw...)
	for c := range s.clients {
		if c == from {
			continue
		}
		if c.replaying {
			c.held = append(c.held, msg)
			continue
		}
		c.queue(msg)
	}
}
