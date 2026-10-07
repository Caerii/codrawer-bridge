// Package dockfile keeps agents' dock entries in /run/codrawer/dock.json for the tablet's dock.
//
// # The problem
//
// The dock that codrawer-layer injects into xochitl's toolbar (bridge/remarkable/xovi/
// codrawer-layer, src/inject.h) lists its rows from /run/codrawer/dock.json, re-read whenever the
// file changes. Agents announce the rows they answer with `dock_entries` (docs/protocol.md):
// `{"t":"dock_entries","owner":"agentd","entries":[{"id","label","badge"?,"hint"?,"kind"?},…]}`,
// on joining and again in answer to `dock_query`; a tap comes back to them as `dock_action` with
// the row's id. This package is the bridge's side: it keeps each owner's latest list and writes
// them all into the file.
//
// # The file
//
//	{"entries":[…], "owners":{"agentd":[…], "primer":[…]}}
//
// `entries`, when present, is the user's own list (it replaces the dock's built-in rows; protocol
// .md, typer speeds) and is kept as it is; this package writes only `owners`. The extension shows
// the base rows, then each owner's rows in owner-name order (an owner's row with an id already
// shown updates that row instead).
//
// # Rules
//
//   - An owner's list replaces its previous one whole; an empty list removes the owner.
//   - The router withdraws an owner's entries when the agent that announced them disconnects (an
//     empty list, router/conn.go leave), and the bridge forgets every owner when its own router
//     connection drops (Reset): it asks again with `dock_query` on the next connection, so what
//     the dock offers is always what somebody connected answers.
//   - Input is bounded and cleaned: at most 16 owners of up to 32 characters, 12 entries each, ids
//     up to 48 characters, labels 80, hints 160; badge a string (up to 24) or a bool; kind a
//     short string. Anything else in an entry is dropped. A malformed message changes nothing.
//   - Writes are atomic (a temporary file renamed over the old one), so the extension never reads
//     half a file.
package dockfile

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

// Limits on what one message may put into the file.
const (
	MaxOwners  = 16
	MaxEntries = 12
	maxOwner   = 32
	maxID      = 48
	maxLabel   = 80
	maxHint    = 160
	maxBadge   = 24
	maxKind    = 24
)

// Entry is one dock row an agent answers.
type Entry struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Badge any    `json:"badge,omitempty"` // a string, or a bool (true shows "on")
	Hint  string `json:"hint,omitempty"`
	Kind  string `json:"kind,omitempty"`
}

// File is the dock file and the owners' lists behind it. Safe for concurrent use.
type File struct {
	mu     sync.Mutex
	path   string
	owners map[string][]Entry
}

// New returns a File writing to path (nothing is written until an owner announces entries).
func New(path string) *File { return &File{path: path, owners: map[string][]Entry{}} }

// message is the part of a router message this package reads.
type message struct {
	T       string            `json:"t"`
	Owner   string            `json:"owner"`
	Entries []json.RawMessage `json:"entries"`
}

// Handle applies a router message: a valid `dock_entries` replaces (or, empty, removes) its
// owner's list and rewrites the file. It reports whether the file changed, and an error for a
// dock_entries it refused or could not write. Other messages are ignored (false, nil).
func (f *File) Handle(raw []byte) (bool, error) {
	if !bytes.Contains(raw, []byte(`"dock_entries"`)) {
		return false, nil
	}
	var m message
	if json.Unmarshal(raw, &m) != nil || m.T != "dock_entries" {
		return false, nil
	}
	owner, ok := cleanString(m.Owner, maxOwner)
	if !ok || owner == "" {
		return false, fmt.Errorf("dock_entries: bad owner %q", m.Owner)
	}
	entries := make([]Entry, 0, len(m.Entries))
	for _, r := range m.Entries {
		if e, ok := cleanEntry(r); ok && len(entries) < MaxEntries {
			entries = append(entries, e)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(entries) == 0 {
		if _, had := f.owners[owner]; !had {
			return false, nil
		}
		delete(f.owners, owner)
	} else {
		if _, had := f.owners[owner]; !had && len(f.owners) >= MaxOwners {
			return false, fmt.Errorf("dock_entries: more than %d owners; %q refused", MaxOwners, owner)
		}
		f.owners[owner] = entries
	}
	return true, f.writeLocked()
}

// Reset forgets every owner (the router connection dropped) and rewrites the file if any were
// there.
func (f *File) Reset() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.owners) == 0 {
		return nil
	}
	f.owners = map[string][]Entry{}
	return f.writeLocked()
}

// Owners returns the owners' names in order (for logs and tests).
func (f *File) Owners() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	names := make([]string, 0, len(f.owners))
	for o := range f.owners {
		names = append(names, o)
	}
	sort.Strings(names)
	return names
}

func (f *File) writeLocked() error {
	old, _ := os.ReadFile(f.path)
	data := Merge(old, f.owners)
	tmp := f.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Clean(f.path))
}

// Merge returns the dock file for existing (the current file's bytes, possibly empty or not
// JSON) with `owners` replaced by owners: every other top-level key is kept. Pure.
func Merge(existing []byte, owners map[string][]Entry) []byte {
	top := map[string]json.RawMessage{}
	if len(bytes.TrimSpace(existing)) > 0 {
		if json.Unmarshal(existing, &top) != nil {
			top = map[string]json.RawMessage{}
		}
	}
	if len(owners) == 0 {
		delete(top, "owners")
	} else {
		b, _ := json.Marshal(owners) // map keys are sorted by encoding/json
		top["owners"] = b
	}
	out, _ := json.Marshal(top)
	return append(out, '\n')
}

// cleanEntry decodes one entry and keeps its known fields within bounds; ok is false without a
// usable id and label.
func cleanEntry(raw json.RawMessage) (Entry, bool) {
	var in struct {
		ID    string          `json:"id"`
		Label string          `json:"label"`
		Badge json.RawMessage `json:"badge"`
		Hint  string          `json:"hint"`
		Kind  string          `json:"kind"`
	}
	if json.Unmarshal(raw, &in) != nil {
		return Entry{}, false
	}
	var e Entry
	var ok bool
	if e.ID, ok = cleanString(in.ID, maxID); !ok || e.ID == "" {
		return Entry{}, false
	}
	if e.Label, ok = cleanString(in.Label, maxLabel); !ok || e.Label == "" {
		return Entry{}, false
	}
	e.Hint, _ = cleanString(in.Hint, maxHint)
	e.Kind, _ = cleanString(in.Kind, maxKind)
	var b any
	if len(in.Badge) > 0 && json.Unmarshal(in.Badge, &b) == nil {
		switch v := b.(type) {
		case bool:
			e.Badge = v
		case string:
			if s, ok := cleanString(v, maxBadge); ok && s != "" {
				e.Badge = s
			}
		}
	}
	return e, true
}

// cleanString trims s, drops control characters and cuts it to max runes; ok is false for
// invalid UTF-8.
func cleanString(s string, max int) (string, bool) {
	if !utf8.ValidString(s) {
		return "", false
	}
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if r < 0x20 || r == 0x7f {
			continue
		}
		if n == max {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String(), true
}
