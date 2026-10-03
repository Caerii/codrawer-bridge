// Package release builds, signs and verifies codrawer releases for the tablet
// (docs/investigations/durable-install.md §6.5).
//
// # Why
//
// Everything codrawer runs on the tablet lives under /home/root/codrawer/releases/<version>/ so
// that it survives OS updates, and boot.sh switches between releases with a symlink
// (durable-install.md §6.1). A release that reaches the tablet over the network must be exactly
// what was built: boot.sh `activate` verifies it with the binary already trusted (the current
// release's), or the new one on a first install, before switching to it.
//
// # Format
//
// A release is a directory of files plus:
//
//	MANIFEST      "version <v>" then one "<sha256 hex>  <relative/path>" line per file, sorted
//	MANIFEST.sig  base64 ed25519 signature over the MANIFEST bytes, then a newline
//
// The format is plain text so shell scripts can read the version (boot.sh: `sed -n '1s/^version
// //p'`). Keys are base64: the private key is the 32-byte ed25519 seed, the public key the 32-byte
// key. Verification checks the signature first, then every hash, and rejects files the manifest
// does not list, so a release on the tablet is exactly what was signed: nothing changed, nothing
// added.
//
// Two front ends use it: `codrawer_bridge_native release …` on the tablet (release_cmd.go) and
// cmd/codrawer-release on the desktop.
package release

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// File names of the manifest and its signature inside a release directory. Neither is listed
// in the manifest.
const (
	ManifestName  = "MANIFEST"
	SignatureName = "MANIFEST.sig"
)

// ── keys ────────────────────────────────────────────────────────────────────

// GenerateKey returns a new key pair as base64 strings (the private key is the 32-byte seed).
func GenerateKey() (priv, pub string, err error) {
	pk, sk, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(sk.Seed()), base64.StdEncoding.EncodeToString(pk), nil
}

func parsePriv(s string) (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("private key: want base64 of a 32-byte ed25519 seed")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

func parsePub(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, errors.New("public key: want base64 of a 32-byte ed25519 key")
	}
	return ed25519.PublicKey(b), nil
}

// ── building and signing ────────────────────────────────────────────────────

// BuildManifest writes MANIFEST for every file in dir. The version must be non-empty and free of
// spaces, newlines and slashes (it names the release directory on the tablet).
func BuildManifest(dir, version string) error {
	if version == "" || strings.ContainsAny(version, " \n/") {
		return fmt.Errorf("bad version %q", version)
	}
	names, err := files(dir)
	if err != nil {
		return err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "version %s\n", version)
	for _, n := range names {
		h, err := hashFile(filepath.Join(dir, filepath.FromSlash(n)))
		if err != nil {
			return err
		}
		fmt.Fprintf(&b, "%s  %s\n", h, n)
	}
	return os.WriteFile(filepath.Join(dir, ManifestName), b.Bytes(), 0o644)
}

// Sign writes MANIFEST.sig for the existing MANIFEST.
func Sign(dir, privB64 string) error {
	sk, err := parsePriv(privB64)
	if err != nil {
		return err
	}
	m, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return err
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(sk, m))
	return os.WriteFile(filepath.Join(dir, SignatureName), []byte(sig+"\n"), 0o644)
}

// ── verifying ───────────────────────────────────────────────────────────────

// Verify checks the signature, every file's hash, and that no unlisted file is present.
// It returns the release's version.
func Verify(dir, pubB64 string) (string, error) {
	m, err := verifiedManifest(dir, pubB64)
	if err != nil {
		return "", err
	}
	lines := strings.Split(strings.TrimRight(string(m), "\n"), "\n")
	if len(lines) == 0 || !strings.HasPrefix(lines[0], "version ") {
		return "", errors.New("manifest: missing version line")
	}
	version := strings.TrimPrefix(lines[0], "version ")
	listed, err := checkListed(dir, lines[1:])
	if err != nil {
		return "", err
	}
	if err := checkUnlisted(dir, listed); err != nil {
		return "", err
	}
	return version, nil
}

// verifiedManifest returns the MANIFEST bytes once MANIFEST.sig is a valid signature over them.
func verifiedManifest(dir, pubB64 string) ([]byte, error) {
	pk, err := parsePub(pubB64)
	if err != nil {
		return nil, err
	}
	m, err := os.ReadFile(filepath.Join(dir, ManifestName))
	if err != nil {
		return nil, err
	}
	sigText, err := os.ReadFile(filepath.Join(dir, SignatureName))
	if err != nil {
		return nil, err
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sigText)))
	if err != nil || !ed25519.Verify(pk, m, sig) {
		return nil, errors.New("signature does not match the manifest")
	}
	return m, nil
}

// checkListed checks each manifest line in order: well formed, a relative path that cannot
// escape dir, and a matching hash. It returns the set of listed names.
func checkListed(dir string, lines []string) (map[string]bool, error) {
	listed := map[string]bool{}
	for _, l := range lines {
		want, name, ok := strings.Cut(l, "  ")
		if !ok || name == "" || strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			return nil, fmt.Errorf("manifest: bad line %q", l)
		}
		got, err := hashFile(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if got != want {
			return nil, fmt.Errorf("%s: hash mismatch", name)
		}
		listed[name] = true
	}
	return listed, nil
}

// checkUnlisted rejects any file in dir that the manifest does not list.
func checkUnlisted(dir string, listed map[string]bool) error {
	present, err := files(dir)
	if err != nil {
		return err
	}
	for _, n := range present {
		if !listed[n] {
			return fmt.Errorf("%s: not in the manifest", n)
		}
	}
	return nil
}

// ── files ───────────────────────────────────────────────────────────────────

// files lists the release's files (relative, slash-separated, sorted), excluding the manifest
// and its signature. Anything that is not a regular file (a symlink, a device) is an error.
func files(dir string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == ManifestName || rel == SignatureName {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("%s: not a regular file", rel)
		}
		out = append(out, rel)
		return nil
	})
	sort.Strings(out)
	return out, err
}

// hashFile returns the file's SHA-256 as lowercase hex.
func hashFile(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
