package router

// Shared live editing (docs/protocol.md, doc_update / doc_state / doc_compact).
//
// Clients keep the session document as a Yjs CRDT and send each batch of local edits as
// {"t":"doc_update","u":<base64>}. The router never decodes them: it relays each one, keeps the
// log and replays it to joiners. Updates are idempotent and commutative, which is what makes the
// simple scheme below safe.
//
// Compaction: when the log grows past docCompactAt, the router sends {"t":"doc_compact"} to the
// client that just wrote (it is alive and holds the whole document) and remembers the log length
// at that moment. The client answers {"t":"doc_state","u":<full state>}, and the log becomes that
// state plus everything that arrived after the request. Nothing is lost: the client had received
// the whole log up to the request (its queue is ordered), and any overlap is harmless. If the
// asked client never answers within docCompactAfter (or leaves), the next writer is asked.

import "time"

// docUpdateLocked appends one update from c to the log, relays it and, if the log is due for
// compaction and nobody is (still) being asked, asks c.
func (s *session) docUpdateLocked(u string, raw []byte, c *client) {
	s.docLog = append(s.docLog, u)
	s.broadcastLocked(raw, c)
	stale := s.compactWho != nil && time.Since(s.compactAsked) > docCompactAfter
	if len(s.docLog) > docCompactAt && (s.compactWho == nil || stale) {
		s.compactWho, s.compactFrom, s.compactAsked = c, len(s.docLog), time.Now()
		c.queue([]byte(`{"t":"doc_compact"}`))
	}
}

// docStateLocked accepts a compaction answer, but only from the client that was asked.
func (s *session) docStateLocked(u string, c *client) {
	if u != "" && s.compactWho == c {
		s.docLog = append([]string{u}, s.docLog[s.compactFrom:]...)
		s.compactWho = nil
	}
}
