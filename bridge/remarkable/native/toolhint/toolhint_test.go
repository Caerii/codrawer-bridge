package toolhint

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func write(t *testing.T, path, line string, mtime time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func TestParse(t *testing.T) {
	for in, want := range map[string]string{
		"eraser 4\n": "eraser", "pen 1": "pen", "Erase_Area 1\n": "erase_area",
		"none\n": "", "unknown\n": "", "": "", "  \n": "",
	} {
		if got := Parse(in); got != want {
			t.Errorf("Parse(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFreshFileIsRead(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	p := filepath.Join(t.TempDir(), "tool")
	write(t, p, "eraser 4\n", now.Add(-time.Second))
	f := &File{Path: p, Now: func() time.Time { return now }}
	if got := f.Tool(); got != "eraser" {
		t.Fatalf("tool %q, want eraser", got)
	}
}

func TestMissingOrStaleFileIsUnknown(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	p := filepath.Join(t.TempDir(), "tool")
	f := &File{Path: p, Now: func() time.Time { return now }}
	if got := f.Tool(); got != "" {
		t.Fatalf("missing file: %q", got)
	}
	// a stock xochitl leaves the last line behind; it stops counting after MaxAge
	write(t, p, "eraser 4\n", now.Add(-4*time.Second))
	now = now.Add(200 * time.Millisecond)
	if got := f.Tool(); got != "" {
		t.Fatalf("stale file: %q", got)
	}
}

func TestChangesAreSeenAfterEvery(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	p := filepath.Join(t.TempDir(), "tool")
	write(t, p, "pen 1\n", now)
	f := &File{Path: p, Now: func() time.Time { return now }}
	if got := f.Tool(); got != "pen" {
		t.Fatalf("tool %q", got)
	}
	write(t, p, "eraser 4\n", now.Add(50*time.Millisecond))
	now = now.Add(50 * time.Millisecond)
	if got := f.Tool(); got != "pen" { // within Every: the cached value, no stat
		t.Fatalf("within Every: %q", got)
	}
	now = now.Add(60 * time.Millisecond)
	if got := f.Tool(); got != "eraser" {
		t.Fatalf("after Every: %q", got)
	}
	// the heartbeat keeps it alive; then the file goes away
	if err := os.Remove(p); err != nil {
		t.Fatal(err)
	}
	now = now.Add(200 * time.Millisecond)
	if got := f.Tool(); got != "" {
		t.Fatalf("removed: %q", got)
	}
}
