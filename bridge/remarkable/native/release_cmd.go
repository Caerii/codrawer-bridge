package main

// `codrawer_bridge_native release …`: the release tool built into the tablet binary, so the
// tablet can verify a new release with the binary it already trusts (boot.sh activate) without
// shipping a second tool. Package release documents the format; cmd/codrawer-release is the
// desktop front end.

import (
	"fmt"
	"os"
	"strings"

	"codrawer-bridge-native/release"
)

// runRelease implements the subcommands and returns the exit status (0 ok, 1 failed, 2 usage):
//
//	release keygen <priv-file> <pub-file>
//	release manifest <dir> <version>
//	release sign <dir> <priv-file>
//	release verify <dir> <pub-file-or-base64>   prints the version; exit 1 if invalid
//
// A key argument that is not a readable file is taken as the key itself (base64).
func runRelease(args []string) int {
	usage := func() int {
		fmt.Fprintln(os.Stderr, "usage: release keygen <priv> <pub> | manifest <dir> <version> | sign <dir> <priv> | verify <dir> <pub>")
		return 2
	}
	if len(args) < 3 {
		return usage()
	}
	var err error
	switch args[0] {
	case "keygen":
		var priv, pub string
		if priv, pub, err = release.GenerateKey(); err == nil {
			if err = os.WriteFile(args[1], []byte(priv+"\n"), 0o600); err == nil {
				err = os.WriteFile(args[2], []byte(pub+"\n"), 0o644)
			}
		}
	case "manifest":
		err = release.BuildManifest(args[1], args[2])
	case "sign":
		err = release.Sign(args[1], keyArg(args[2]))
	case "verify":
		var v string
		if v, err = release.Verify(args[1], keyArg(args[2])); err == nil {
			fmt.Println(v)
		}
	default:
		return usage()
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "release %s: %v\n", args[0], err)
		return 1
	}
	return 0
}

// keyArg returns the trimmed contents of the key file p, or p itself when it is not a readable
// file (a key given inline).
func keyArg(p string) string {
	if b, err := os.ReadFile(p); err == nil {
		return strings.TrimSpace(string(b))
	}
	return p
}
