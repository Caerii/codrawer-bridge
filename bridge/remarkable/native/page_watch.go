package main

// The page watcher (package pagewatch): xochitl's saved page is the source of truth. It runs
// next to the pen stream, reads xochitl's files read-only, and sends a `page` snapshot whenever
// the open page's .rm is rewritten or the page changes; the latest snapshot is resent on every
// reconnect so a restarted router learns the page again.

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"codrawer-bridge-native/pagewatch"
)

// pageWatchEnabled: "on"/"1" and "off"/"0" decide; "auto" (default) runs it only on an OS
// version boot.sh lists as tested (CODRAWER_OS_TESTED=1 from /run/codrawer/env), since the
// file layout is xochitl's private format.
func pageWatchEnabled(mode, osTested string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "on", "1", "true", "yes":
		return true
	case "off", "0", "false", "no":
		return false
	}
	return strings.TrimSpace(osTested) == "1"
}

// pageFeed holds the latest page snapshot for whichever socket is up.
type pageFeed struct {
	mu     sync.Mutex
	latest []byte
	seq    int
	notify chan struct{}
}

func newPageFeed() *pageFeed { return &pageFeed{notify: make(chan struct{}, 1)} }

func (f *pageFeed) set(b []byte) {
	f.mu.Lock()
	f.latest, f.seq = b, f.seq+1
	f.mu.Unlock()
	select {
	case f.notify <- struct{}{}:
	default:
	}
}

func (f *pageFeed) get() ([]byte, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.latest, f.seq
}

// runPageWatch polls xochitl's directory for the life of the process.
func runPageWatch(dir string, every time.Duration, feed *pageFeed, debug bool) {
	w := &pagewatch.Watcher{Dir: dir}
	fmt.Printf("[page] watching %s every %s (read-only)\n", dir, every)
	lastErr := ""
	t := time.NewTicker(every)
	defer t.Stop()
	for ; ; <-t.C {
		b, err := w.Poll()
		if err != nil {
			// a file mid-write or no document yet: say it once, retry quietly
			if e := err.Error(); e != lastErr || debug {
				fmt.Printf("[page] %v (retrying)\n", err)
				lastErr = e
			}
			continue
		}
		lastErr = ""
		if b == nil {
			continue
		}
		feed.set(b)
		fmt.Printf("[page] %s (%d bytes)\n", pageSummary(b), len(b))
	}
}

// pageSummary is a short log line for a page message (doc, page, rev; no stroke data).
func pageSummary(b []byte) string {
	s := string(b)
	if i := strings.Index(s, `,"strokes":`); i > 0 {
		s = s[:i] + "}"
	}
	return s
}

// pumpPages sends the latest snapshot on the current socket, then each new one, until stop.
func pumpPages(ws *WSConn, feed *pageFeed, stop <-chan struct{}) {
	sent := 0
	// the ticker covers a notify swallowed by the previous connection's pump as it exits
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		if b, seq := feed.get(); b != nil && seq != sent {
			if err := ws.WriteRaw(b); err != nil {
				ws.sendErr(err)
				return
			}
			sent = seq
		}
		select {
		case <-stop:
			return
		case <-feed.notify:
		case <-tick.C:
		}
	}
}
