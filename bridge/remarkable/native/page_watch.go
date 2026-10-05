package main

// The page watcher in the bridge (package pagewatch does the work).
//
// xochitl's saved page is the source of truth for what is on the page (ADR 008). The watcher
// runs next to the pen stream for the life of the process, reads xochitl's files read-only, and
// produces a `page` snapshot whenever the open page's .rm is rewritten (~6–10 s after the user
// pauses) or the page changes (~1–2 s after a turn; docs/investigations/xochitl-pen-data.md).
//
// Snapshots do not go through the outbox: only the latest one matters, so it is kept in a
// pageFeed, and each connection's pumpPages sends it on connect and then every newer one. A
// restarted router therefore learns the page again on the bridge's next reconnect.

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"codrawer-bridge-native/pagewatch"
)

// pageWatchEnabled: "on"/"1" and "off"/"0" (also true/yes, false/no) decide; anything else, and
// "auto" (the default), runs it only on an OS version boot.sh lists as tested
// (CODRAWER_OS_TESTED=1 from /run/codrawer/env, compat.conf), since the file layout is xochitl's
// private format (docs/investigations/durable-install.md §6.6).
func pageWatchEnabled(mode, osTested string) bool {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "on", "1", "true", "yes":
		return true
	case "off", "0", "false", "no":
		return false
	}
	return strings.TrimSpace(osTested) == "1"
}

// pageFeed holds the latest page snapshot for whichever socket is up. seq counts snapshots, so a
// pump can tell whether it has sent the latest.
type pageFeed struct {
	mu     sync.Mutex
	latest []byte
	seq    int
	notify chan struct{} // capacity 1: "something newer exists"
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

// runPageWatch polls xochitl's directory every `every` for the life of the process. Errors (a
// file mid-write, no document yet) are logged once each, or every time with -debug.
func runPageWatch(dir string, every time.Duration, feed *pageFeed, debug bool) {
	w := &pagewatch.Watcher{Dir: dir}
	fmt.Printf("[page] watching %s every %s (read-only)\n", dir, every)
	lastErr := ""
	t := time.NewTicker(every)
	defer t.Stop()
	for ; ; <-t.C {
		b, err := w.Poll()
		if err != nil {
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

// pageSummary is a short log line for a page message (doc, page, title, rev, size; no strokes).
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
