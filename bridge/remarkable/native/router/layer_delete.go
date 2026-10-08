package router

import "encoding/json"

// Preserve all page metadata and user/peer ink; only native AI strokes are removed.
func withoutAgentInk(raw []byte) []byte {
	var page map[string]json.RawMessage
	if json.Unmarshal(raw, &page) != nil {
		return raw
	}
	var strokes []json.RawMessage
	if json.Unmarshal(page["strokes"], &strokes) != nil {
		return raw
	}
	kept := make([]json.RawMessage, 0, len(strokes))
	for _, s := range strokes {
		var row struct {
			Layer string `json:"layer"`
		}
		if json.Unmarshal(s, &row) != nil || row.Layer != "ai" {
			kept = append(kept, s)
		}
	}
	page["strokes"], _ = json.Marshal(kept)
	out, _ := json.Marshal(page)
	return out
}

func (s *session) agentLayerDeletedLocked(m envelope, from *client) {
	if m.Doc == "" || m.Page == "" || s.pageKey != m.Doc+"/"+m.Page {
		return
	}
	s.aiDeletedAt = m.Ts
	ids := []string{}
	for _, id := range s.order {
		if st := s.strokes[id]; st != nil && st.layer == "ai" {
			ids = append(ids, id)
		}
	}
	gone := s.deleteLocked(ids, from) // AI ink is deletable by any participant.
	if len(gone) > 0 {
		s.broadcastLocked(mustJSON(strokeDelete{"stroke_delete", gone, m.Ts}), nil)
	}
	s.page = withoutAgentInk(s.page)
	if len(s.page) > 0 {
		s.broadcastLocked(s.page, nil)
	}
}
