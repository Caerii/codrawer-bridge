package main

// The dock's agent entries: the router's `dock_entries` into /run/codrawer/dock.json.
//
// Agents announce the dock rows they answer with `dock_entries` (docs/protocol.md); package
// dockfile keeps each owner's latest list in the file the codrawer-layer extension reads for the
// dock's rows. The link ties that to the connection: every message from the router passes
// through onMessage; each new connection asks the agents to announce again (`dock_query`), and a
// dropped connection forgets every owner first, so the dock never offers rows that no connected
// agent answers. The router itself withdraws an agent's rows when that agent leaves
// (router/conn.go). Off when the directory is missing (not a tablet) or DOCK_JSON=off.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"codrawer-bridge-native/dockfile"
)

const defaultDockJSON = "/run/codrawer/dock.json"

// dockQuery is sent first on every connection.
var dockQuery = []byte(`{"t":"dock_query"}`)

// dockLink is nil when the dock file is off; its methods are no-ops then.
type dockLink struct {
	file *dockfile.File
}

// startDock returns the link for path (DOCK_JSON overrides the default), or nil.
func startDock() *dockLink {
	path := strings.TrimSpace(os.Getenv("DOCK_JSON"))
	if path == "" {
		path = defaultDockJSON
	}
	if strings.EqualFold(path, "off") {
		return nil
	}
	if st, err := os.Stat(filepath.Dir(path)); err != nil || !st.IsDir() {
		fmt.Printf("[dock] %s: no such directory; agents' dock entries off\n", filepath.Dir(path))
		return nil
	}
	fmt.Printf("[dock] agents' dock entries into %s\n", path)
	return &dockLink{file: dockfile.New(path)}
}

// onMessage applies a router message (only dock_entries matter).
func (d *dockLink) onMessage(b []byte) {
	if d == nil {
		return
	}
	changed, err := d.file.Handle(b)
	if err != nil {
		fmt.Printf("[dock] %v\n", err)
	} else if changed {
		fmt.Printf("[dock] entries now from %v\n", d.file.Owners())
	}
}

// query is what to send first on a new connection (nil when off).
func (d *dockLink) query() []byte {
	if d == nil {
		return nil
	}
	return dockQuery
}

// disconnected forgets every owner: they announce again when asked on the next connection.
func (d *dockLink) disconnected() {
	if d == nil {
		return
	}
	if err := d.file.Reset(); err != nil {
		fmt.Printf("[dock] reset: %v\n", err)
	}
}
