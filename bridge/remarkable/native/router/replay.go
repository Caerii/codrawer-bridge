package router

// Replay: the page at one instant, rendered as the messages a client would have seen live.

import "encoding/json"

// pageSnapshot is the page at one instant. It only copies slice headers: point slices are
// append-only and a re-begun stroke gets a new struct, so the elements it covers never change
// after the lock is released, and messages() can run without it.
type pageSnapshot struct {
	page    []byte // the latest `page` message (never modified once stored), or nil
	strokes []strokeSnap
	doc     []string
}

// strokeSnap is one recorded stroke as of the snapshot.
type strokeSnap struct {
	id    string
	begin []byte
	pts   []json.RawMessage
	ended bool
}

// snapshotLocked takes the snapshot. The full slice expressions cap each copy at its current
// length, so a later append in the session can never write into what the snapshot sees.
func (s *session) snapshotLocked() pageSnapshot {
	snap := pageSnapshot{page: s.page, doc: s.docLog[:len(s.docLog):len(s.docLog)]}
	for _, id := range s.order {
		if st := s.strokes[id]; st != nil {
			snap.strokes = append(snap.strokes, strokeSnap{id, st.begin, st.pts[:len(st.pts):len(st.pts)], st.ended})
		}
	}
	return snap
}

// messages renders the snapshot in replay order: the page base, then each stroke (its original
// stroke_begin, its points in stroke_pts messages of replayPts, and stroke_end if it ended), then
// the document log in doc_update messages of docReplayN updates ({"t":"doc_update","us":[…]}).
func (snap pageSnapshot) messages() [][]byte {
	var out [][]byte
	if snap.page != nil {
		out = append(out, snap.page) // the base first, then the ink drawn since
	}
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
