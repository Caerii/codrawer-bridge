package router

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestSessionID(t *testing.T) {
	for path, want := range map[string]string{"/ws/session1": "session1", "/ws/s1/": "s1", "/ws/": "", "/ws/a/b": ""} {
		got, ok := sessionID(path)
		if got != want || ok != (want != "") {
			t.Errorf("sessionID(%q) = %q, %v; want %q", path, got, ok, want)
		}
	}
}

func newSession() *session {
	return &session{clients: map[*client]bool{}, strokes: map[string]*stroke{}}
}

func begin(s *session, id string) {
	s.recordLocked(envelope{T: "stroke_begin", ID: id}, []byte(`{}`), nil)
}

// The point bound forgets the oldest strokes first and never the newest one.
func TestEvictionDropsOldestFirst(t *testing.T) {
	s := newSession()
	pts := make([]json.RawMessage, maxStrokePoints)
	for i := range pts {
		pts[i] = json.RawMessage(`[0,0,0,0]`)
	}
	n := maxPoints/maxStrokePoints + 2
	for i := 0; i < n; i++ {
		id := fmt.Sprint("u_", i)
		begin(s, id)
		s.recordLocked(envelope{T: "stroke_pts", ID: id, Pts: pts}, nil, nil)
	}
	if s.points > maxPoints {
		t.Fatalf("points %d over the bound %d", s.points, maxPoints)
	}
	if s.order[len(s.order)-1] != fmt.Sprint("u_", n-1) {
		t.Fatalf("newest stroke evicted: %v", s.order)
	}
	if _, ok := s.strokes["u_0"]; ok {
		t.Fatal("oldest stroke kept")
	}
}

// One stroke records at most maxStrokePoints; points for an unknown stroke record nothing.
func TestStrokePointCap(t *testing.T) {
	s := newSession()
	begin(s, "u_1")
	pts := make([]json.RawMessage, maxStrokePoints+10)
	s.recordLocked(envelope{T: "stroke_pts", ID: "u_1", Pts: pts}, nil, nil)
	s.recordLocked(envelope{T: "stroke_pts", ID: "u_2", Pts: pts}, nil, nil)
	if got := len(s.strokes["u_1"].pts); got != maxStrokePoints || s.points != maxStrokePoints {
		t.Fatalf("recorded %d points (session %d), want %d", got, s.points, maxStrokePoints)
	}
}
