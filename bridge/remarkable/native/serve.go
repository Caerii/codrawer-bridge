package main

// -serve: the stroke router (package router) inside the bridge, so the glasses app connects to
// the tablet directly (ADR 007). The bridge then streams into it over loopback, which the router
// exempts from the pairing code.

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"codrawer-bridge-native/router"
)

// serveRouter runs the stroke router until the process exits; a failed listen is fatal
// because the glasses app would otherwise have nothing to connect to.
func serveRouter(addr string) {
	r := router.New()
	r.Token = os.Getenv("ROUTER_TOKEN") // pairing code for clients off the tablet (bridge.env)
	r.Info = hostInfo(os.Getenv)
	srv := &http.Server{Addr: addr, Handler: r.Handler(), ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("[router] listening on %s\n", addr)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: router: %v\n", err)
		os.Exit(1)
	}
}

// hostInfo is what boot.sh derived for this boot (/run/codrawer/env, loaded into the service's
// environment), sent to clients in hello as "tablet": the OS version, whether it is a tested one,
// the codrawer release, and the OS version before an update. Unset values are left out.
func hostInfo(getenv func(string) string) map[string]string {
	info := map[string]string{}
	for key, env := range map[string]string{"os": "CODRAWER_OS", "osTested": "CODRAWER_OS_TESTED", "version": "CODRAWER_VERSION", "osChangedFrom": "CODRAWER_OS_CHANGED"} {
		if v := getenv(env); v != "" {
			info[key] = v
		}
	}
	return info
}
