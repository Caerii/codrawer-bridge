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
	srv := &http.Server{Addr: addr, Handler: router.New().Handler(), ReadHeaderTimeout: 10 * time.Second}
	fmt.Printf("[router] listening on %s\n", addr)
	if err := srv.ListenAndServe(); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: router: %v\n", err)
		os.Exit(1)
	}
}
