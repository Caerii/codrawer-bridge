package dockfile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readFile(t *testing.T, p string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	return m
}

// agentd's entries land under owners, replace its last list whole, and go with an empty list;
// the user's own `entries` stay untouched throughout.
func TestOwnersLifecycleKeepsUserEntries(t *testing.T) {
	p := filepath.Join(t.TempDir(), "dock.json")
	if err := os.WriteFile(p, []byte(`{"entries":[{"id":"typer_fast","label":"Reply typing: fast"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	f := New(p)
	changed, err := f.Handle([]byte(`{"t":"dock_entries","owner":"agentd","entries":[
		{"id":"agentd_memory","label":"Memory: page thread","badge":"on","extra":1},
		{"id":"agentd_forget","label":"Forget this page's thread"}]}`))
	if !changed || err != nil {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	m := readFile(t, p)
	if _, ok := m["entries"]; !ok {
		t.Fatal("the user's entries were dropped")
	}
	ag := m["owners"].(map[string]any)["agentd"].([]any)
	if len(ag) != 2 || ag[0].(map[string]any)["badge"] != "on" {
		t.Fatalf("agentd: %v", ag)
	}
	if _, ok := ag[0].(map[string]any)["extra"]; ok {
		t.Fatal("unknown fields must be dropped")
	}
	// a new list replaces the old whole: the badge goes off, the forget row goes
	f.Handle([]byte(`{"t":"dock_entries","owner":"agentd","entries":[{"id":"agentd_memory","label":"Memory: off","badge":false}]}`))
	ag = readFile(t, p)["owners"].(map[string]any)["agentd"].([]any)
	if len(ag) != 1 || ag[0].(map[string]any)["label"] != "Memory: off" || ag[0].(map[string]any)["badge"] != false {
		t.Fatalf("replaced: %v", ag)
	}
	// withdrawn: the owner and the `owners` key go, the user's entries stay
	if changed, _ := f.Handle([]byte(`{"t":"dock_entries","owner":"agentd","entries":[]}`)); !changed {
		t.Fatal("an empty list must remove the owner")
	}
	m = readFile(t, p)
	if _, ok := m["owners"]; ok {
		t.Fatalf("owners left: %v", m)
	}
	if _, ok := m["entries"]; !ok {
		t.Fatal("the user's entries were dropped")
	}
}

func TestResetForgetsEveryOwner(t *testing.T) {
	p := filepath.Join(t.TempDir(), "dock.json")
	f := New(p)
	f.Handle([]byte(`{"t":"dock_entries","owner":"agentd","entries":[{"id":"a","label":"A"}]}`))
	f.Handle([]byte(`{"t":"dock_entries","owner":"primer","entries":[{"id":"b","label":"B"}]}`))
	if got := strings.Join(f.Owners(), ","); got != "agentd,primer" {
		t.Fatalf("owners %s", got)
	}
	if err := f.Reset(); err != nil {
		t.Fatal(err)
	}
	if _, ok := readFile(t, p)["owners"]; ok || len(f.Owners()) != 0 {
		t.Fatal("reset left owners")
	}
}

func TestRefusesAndBounds(t *testing.T) {
	p := filepath.Join(t.TempDir(), "dock.json")
	f := New(p)
	for _, bad := range []string{
		`{"t":"dock_entries","owner":"","entries":[{"id":"a","label":"A"}]}`,
		`{"t":"dock_entries","owner":"x","entries":[{"id":"","label":"A"},{"label":"no id"},{"id":"no label"}]}`,
		`{"t":"dock_entries","owner":"x","entries":"nope"}`,
		`not json "dock_entries"`,
	} {
		if changed, _ := f.Handle([]byte(bad)); changed {
			t.Fatalf("accepted %s", bad)
		}
	}
	if _, err := os.Stat(p); err == nil {
		t.Fatal("nothing valid came, nothing should be written")
	}
	if changed, err := f.Handle([]byte(`{"t":"dock_action","id":"a"}`)); changed || err != nil {
		t.Fatal("other messages are ignored")
	}
	// bounds: 12 entries, long labels cut, control characters dropped, badge kinds
	var b strings.Builder
	b.WriteString(`{"t":"dock_entries","owner":"agentd","entries":[`)
	for i := 0; i < 20; i++ {
		if i > 0 {
			b.WriteString(",")
		}
		b.WriteString(`{"id":"e` + string(rune('a'+i)) + `","label":"` + strings.Repeat("L", 200) + `\u0007","badge":{"x":1}}`)
	}
	b.WriteString(`]}`)
	f.Handle([]byte(b.String()))
	ag := readFile(t, p)["owners"].(map[string]any)["agentd"].([]any)
	if len(ag) != MaxEntries {
		t.Fatalf("%d entries", len(ag))
	}
	e := ag[0].(map[string]any)
	if l := e["label"].(string); len(l) != maxLabel || strings.ContainsRune(l, 7) {
		t.Fatalf("label %q", l)
	}
	if _, ok := e["badge"]; ok {
		t.Fatal("an object badge must be dropped")
	}
	// too many owners
	for i := 0; i < MaxOwners+2; i++ {
		f.Handle([]byte(`{"t":"dock_entries","owner":"o` + string(rune('a'+i)) + `","entries":[{"id":"a","label":"A"}]}`))
	}
	if n := len(f.Owners()); n != MaxOwners {
		t.Fatalf("%d owners", n)
	}
}

func TestMergeKeepsOtherKeysAndSurvivesGarbage(t *testing.T) {
	out := Merge([]byte(`{"entries":[1],"note":"x"}`), map[string][]Entry{"z": {{ID: "a", Label: "A"}}, "b": {{ID: "c", Label: "C", Badge: true}}})
	s := string(out)
	if !strings.Contains(s, `"note":"x"`) || !strings.Contains(s, `"entries":[1]`) || strings.Index(s, `"b"`) > strings.Index(s, `"z"`) {
		t.Fatalf("%s", s)
	}
	if got := string(Merge([]byte("garbage"), nil)); got != "{}\n" {
		t.Fatalf("%q", got)
	}
}
