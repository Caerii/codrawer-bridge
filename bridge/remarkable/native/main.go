// Command codrawer_bridge_native is the reMarkable Paper Pro half of codrawer: one static binary,
// no Python, that streams what happens on the tablet into a codrawer session and, optionally,
// hosts that session itself.
//
// # What runs on the tablet
//
//	/dev/input/event2 (Elan marker) ──▶ pen reader ──▶ pen.Machine ──▶ outbox ─┐
//	keyboard (Bluetooth, kbd handler) ──▶ keyboard reader ──────────── key ─────┤
//	xochitl's saved pages (read-only) ──▶ page watcher ─────────────── page ────┤
//	                                                                            ▼
//	                                              WebSocket to the router (-ws ws://…/ws/session1)
//	                                                                            │
//	term replies ◀── virtual keyboard (uinput) ◀── typer ◀── `term` messages ◀──┘
//
//	-serve :8577: the stroke router (package router) in the same process; the bridge then
//	streams into it over loopback and the glasses app connects to the tablet directly.
//
// Every source runs for the life of the process and never depends on the socket being up: a
// network outage must never cost pen state (a dropped pen-up once left the pen "down"), and the
// tablet sleeps within ~2 minutes and drops Wi-Fi, so the socket is the least reliable part. The
// connection loop (bridge.go) only drains what the sources produced. Measured costs and budgets
// are in ADR 006; how this composes with the glasses, the desktop and smart_remarkable is ADR 007;
// the page model is ADR 008; the wire format is docs/protocol.md.
//
// # Modes
//
//	codrawer_bridge_native [flags]            the bridge (and the router with -serve)
//	codrawer_bridge_native -router-only -serve :8577
//	codrawer_bridge_native -page-dump         print the open page's `page` message and exit
//	codrawer_bridge_native -list-devices      print the input devices and exit
//	codrawer_bridge_native release …          sign/verify releases (release_cmd.go)
//
// # Reading order
//
// main.go → config.go (flags and env) → bridge.go (wiring and the connection loop) →
// pen_stream.go (pen device → pen.Machine → outbox) → linux_input.go (evdev structs and ioctls) →
// device_select.go (finding the pen) → keyboard.go → typer.go and uinput.go (replies typed into
// the tablet) → page_watch.go → ws_client.go → serve.go → release_cmd.go. The packages: pen (the
// stroke state machine), router, rmlines and pagewatch (the saved page), release.
package main

import (
	"fmt"
	"os"

	"codrawer-bridge-native/pagewatch"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "release" {
		os.Exit(runRelease(os.Args[2:]))
	}
	cfg, pageDump := loadConfig()

	if pageDump {
		os.Exit(dumpPage(cfg.XochitlDir))
	}
	if cfg.ServeAddr != "" {
		go serveRouter(cfg.ServeAddr)
	}
	if cfg.RouterOnly {
		if cfg.ServeAddr == "" {
			fmt.Fprintln(os.Stderr, "fatal: -router-only needs -serve")
			os.Exit(1)
		}
		select {}
	}
	if err := RunBridgeForever(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}

// dumpPage prints the `page` message for the open document and page once (a safe, read-only
// check on the tablet) and returns the exit status.
func dumpPage(dir string) int {
	b, err := (&pagewatch.Watcher{Dir: dir}).Poll()
	if err != nil || b == nil {
		fmt.Fprintf(os.Stderr, "page-dump: %v (no page found)\n", err)
		return 1
	}
	fmt.Printf("%s\n", b)
	return 0
}
