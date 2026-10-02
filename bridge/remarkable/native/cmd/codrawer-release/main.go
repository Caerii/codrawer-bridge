// codrawer-release: build, sign and verify codrawer releases on the desktop (any OS).
// The tablet verifies with the bridge binary's own `release verify`. See package release.
//
//	codrawer-release keygen <priv-file> <pub-file>
//	codrawer-release seal <dir> <version> <priv-file>   manifest + signature
//	codrawer-release verify <dir> <pub-file>
package main

import (
	"fmt"
	"os"
	"strings"

	"codrawer-bridge-native/release"
)

func read(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return strings.TrimSpace(string(b))
}

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: codrawer-release keygen <priv> <pub> | seal <dir> <version> <priv> | verify <dir> <pub>")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		var priv, pub string
		if priv, pub, err = release.GenerateKey(); err == nil {
			if err = os.WriteFile(os.Args[2], []byte(priv+"\n"), 0o600); err == nil {
				err = os.WriteFile(os.Args[3], []byte(pub+"\n"), 0o644)
			}
		}
	case "seal":
		if len(os.Args) < 5 {
			err = fmt.Errorf("seal needs <dir> <version> <priv>")
		} else if err = release.BuildManifest(os.Args[2], os.Args[3]); err == nil {
			err = release.Sign(os.Args[2], read(os.Args[4]))
		}
	case "verify":
		var v string
		if v, err = release.Verify(os.Args[2], read(os.Args[3])); err == nil {
			fmt.Println(v)
		}
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "codrawer-release:", err)
		os.Exit(1)
	}
}
