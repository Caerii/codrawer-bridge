package main

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
	// what boot.sh derived for this boot (/run/codrawer/env → the service's environment)
	r.Info = map[string]string{}
	for key, env := range map[string]string{"os": "CODRAWER_OS", "osTested": "CODRAWER_OS_TESTED", "version": "CODRAWER_VERSION", "osChangedFrom": "CODRAWER_OS_CHANGED"} {
		if v := os.Getenv(env); v != "" {
			r.Info[key] = v
		}
	}
	srv := &http.Server{Addr: addr, Handler: r.Handler(), ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("[router] listening on %s\n", addr)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: router: %v\n", err)
		os.Exit(1)
	}
}
