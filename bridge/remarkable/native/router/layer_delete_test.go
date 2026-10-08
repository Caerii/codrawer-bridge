package router

import (
	"encoding/json"
	"testing"
)

func TestAgentLayerDeletionUpdatesReplayAndRejectsOldSnapshot(t *testing.T) {
	raw := []byte(`{"t":"page","doc":"d","page":"p","rev":10,"w":1404,"strokes":[{"id":"u","layer":"user","pts":[]},{"id":"a","layer":"ai","pts":[]}]}`)
	s := &session{clients: map[*client]bool{}, strokes: map[string]*stroke{}}
	s.setPageLocked(envelope{Doc: "d", Page: "p", Rev: 10}, raw)
	s.strokes["ai-live"] = &stroke{layer: "ai"}
	s.strokes["peer-live"] = &stroke{layer: "peer"}
	s.order = []string{"ai-live", "peer-live"}
	s.agentLayerDeletedLocked(envelope{Doc: "wrong", Page: "p", Ts: 20}, nil)
	if len(s.strokes) != 2 {
		t.Fatal("wrong page deleted ink")
	}
	s.agentLayerDeletedLocked(envelope{Doc: "d", Page: "p", Ts: 20}, nil)
	if s.strokes["ai-live"] != nil || s.strokes["peer-live"] == nil {
		t.Fatal("live layers not preserved correctly")
	}
	check := func() {
		var p struct {
			W       int
			Strokes []struct{ ID string }
		}
		if err := json.Unmarshal(s.page, &p); err != nil {
			t.Fatal(err)
		}
		if p.W != 1404 || len(p.Strokes) != 1 || p.Strokes[0].ID != "u" {
			t.Fatalf("bad cached page: %s", s.page)
		}
	}
	check()
	s.dispatch(envelope{T: "page", Doc: "d", Page: "p", Rev: 10}, raw, nil)
	check()
	fresh := []byte(`{"t":"page","doc":"d","page":"p","rev":30,"strokes":[{"id":"new-ai","layer":"ai"}]}`)
	s.dispatch(envelope{T: "page", Doc: "d", Page: "p", Rev: 30}, fresh, nil)
	if string(s.page) != string(fresh) {
		t.Fatal("later saved ink/undo was suppressed")
	}
}
