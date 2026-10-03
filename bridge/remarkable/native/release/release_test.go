package release

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func signed(t *testing.T) (dir, pub string) {
	t.Helper()
	dir = t.TempDir()
	write(t, dir, "codrawer_bridge_native", "binary")
	write(t, dir, "boot.sh", "#!/bin/sh\n")
	write(t, dir, "units/codrawer-bridge.service", "[Unit]\n")
	priv, pub, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	if err := BuildManifest(dir, "2026.10.02-1"); err != nil {
		t.Fatal(err)
	}
	if err := Sign(dir, priv); err != nil {
		t.Fatal(err)
	}
	return dir, pub
}

func TestSignedReleaseVerifies(t *testing.T) {
	dir, pub := signed(t)
	v, err := Verify(dir, pub)
	if err != nil || v != "2026.10.02-1" {
		t.Fatalf("verify: %q %v", v, err)
	}
	m, _ := os.ReadFile(filepath.Join(dir, ManifestName))
	if !strings.Contains(string(m), "  units/codrawer-bridge.service\n") {
		t.Fatalf("manifest lists nested files with slashes:\n%s", m)
	}
}

func TestTamperingIsRejected(t *testing.T) {
	cases := map[string]func(dir string){
		"changed file": func(dir string) { write(t, dir, "boot.sh", "#!/bin/sh\nrm -rf /\n") },
		"extra file":   func(dir string) { write(t, dir, "evil.sh", "x") },
		"missing file": func(dir string) { _ = os.Remove(filepath.Join(dir, "boot.sh")) },
		"edited manifest": func(dir string) {
			p := filepath.Join(dir, ManifestName)
			m, _ := os.ReadFile(p)
			_ = os.WriteFile(p, []byte(strings.Replace(string(m), "2026.10.02-1", "9999", 1)), 0o644)
		},
	}
	for name, tamper := range cases {
		t.Run(name, func(t *testing.T) {
			dir, pub := signed(t)
			tamper(dir)
			if _, err := Verify(dir, pub); err == nil {
				t.Fatal("tampered release verified")
			}
		})
	}
}

func TestWrongKeyIsRejected(t *testing.T) {
	dir, _ := signed(t)
	_, other, _ := GenerateKey()
	if _, err := Verify(dir, other); err == nil {
		t.Fatal("verified with someone else's key")
	}
}
