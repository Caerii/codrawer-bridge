// Command codrawer-release builds, signs and verifies codrawer releases on the desktop (any OS).
// The tablet verifies with the bridge binary's own `release verify` (release_cmd.go); both are
// thin front ends to package release, which documents the format.
//
//	codrawer-release keygen <priv-file> <pub-file>
//	codrawer-release seal <dir> <version> <priv-file>   manifest + signature
//	codrawer-release verify <dir> <pub-file>            prints the version
//
// scripts/dev/deploy-tablet.sh builds it and seals every release it stages. Exit status: 0 on
// success, 1 on any error, 2 on a usage error.
package main

import (
	"fmt"
	"os"
	"strings"

	"codrawer-bridge-native/release"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Fprintln(os.Stderr, "usage: codrawer-release keygen <priv> <pub> | seal <dir> <version> <priv> | verify <dir> <pub>")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = keygen(os.Args[2], os.Args[3])
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

// keygen writes a new key pair: the private key readable only by the owner.
func keygen(privPath, pubPath string) error {
	priv, pub, err := release.GenerateKey()
	if err != nil {
		return err
	}
	if err := os.WriteFile(privPath, []byte(priv+"\n"), 0o600); err != nil {
		return err
	}
	return os.WriteFile(pubPath, []byte(pub+"\n"), 0o644)
}

// read returns a key file's contents, trimmed; a missing file is fatal.
func read(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	return strings.TrimSpace(string(b))
}
