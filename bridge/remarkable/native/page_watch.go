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
//
// # When to look
//
// The watcher sleeps until xochitl writes (notifyWake: inotify on the data directory and on the
// open document's folder) and polls only then, so an idle tablet costs it nothing. The former
// 1 s poll woke the SoC every second and listed the whole data directory (a stat per entry)
// each time; it was the largest share of the bridge's idle CPU (docs/investigations/idle-cost.md).
// The PAGE_POLL_MS timer is still used in three cases (nextDeadline):
//
//   - inotify is unavailable or broke (pollWake): the old behaviour, a poll every interval;
//   - a poll failed (a .rm mid-write, no document yet): retry after the interval, as before;
//   - otherwise a slow safety poll (safetyPoll), in case an event was missed.
//
// Which events count (notifyWake.relevant): in the data directory, a <doc>.content or
// <doc>.metadata written, renamed or removed, or a folder created or removed (a document); in
// the open document's folder, a .rm written, renamed or removed. xochitl's other writes
// (thumbnails, .local, .pagedata) do not wake the poll. After the open document changes, the
// watcher watches the new document's folder and polls once more at once, since a write may have
// landed before the watch began. This is the Rust engine's page_watch.rs, decision for decision.

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codrawer-bridge-native/pagewatch"

	"golang.org/x/sys/unix"
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
// pump can tell whether it has sent the latest; changed is closed (and replaced) by every set,
// so any number of pumps wake on it and none can swallow another's notice.
type pageFeed struct {
	mu      sync.Mutex
	latest  []byte
	seq     int
	changed chan struct{}
}

func newPageFeed() *pageFeed { return &pageFeed{changed: make(chan struct{})} }

func (f *pageFeed) set(b []byte) {
	f.mu.Lock()
	f.latest, f.seq = b, f.seq+1
	close(f.changed)
	f.changed = make(chan struct{})
	f.mu.Unlock()
}

// get returns the latest snapshot, its seq, and a channel closed by the next set.
func (f *pageFeed) get() ([]byte, int, <-chan struct{}) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.latest, f.seq, f.changed
}

// ── when to poll ────────────────────────────────────────────────────────────

// safetyPoll is, with inotify working, the longest the watcher sleeps without an event: a net
// for a missed event, at one wakeup a minute.
const safetyPoll = 60 * time.Second

// nextDeadline is when the watcher polls next if no change arrives first: after every when only
// polling finds changes or the last poll must be retried, else after safetyPoll.
func nextDeadline(now time.Time, reportsChanges, retry bool, every time.Duration) time.Time {
	if !reportsChanges || retry {
		return now.Add(every)
	}
	return now.Add(safetyPoll)
}

// pageWake is what the watcher sleeps on between polls.
type pageWake interface {
	// reportsChanges: changes are reported as they happen (inotify), not found by polling.
	reportsChanges() bool
	// follow watches the open document's folder ("" for none) and reports whether a new watch
	// began, since a write may have landed before it: the caller then polls at once.
	follow(docDir string) bool
	// wait sleeps until a relevant change or deadline and reports whether a change woke it.
	wait(deadline time.Time) bool
}

// pollWake is the fallback: no events, a sleep until the deadline.
type pollWake struct{}

func (pollWake) reportsChanges() bool  { return false }
func (pollWake) follow(string) bool    { return false }
func (pollWake) wait(d time.Time) bool { time.Sleep(time.Until(d)); return false }

// notifyWake is inotify on xochitl's data directory and on the open document's folder.
type notifyWake struct {
	ino    *inotify
	dirWD  int32
	docDir string // the followed document folder ("" for none) and its watch
	docWD  int32
	broken bool // inotify failed or the data directory went away: poll from now on
}

// newNotifyWake watches dir (xochitl's data directory). It fails when inotify is unavailable or
// dir cannot be watched (missing); the caller then polls.
func newNotifyWake(dir string) (*notifyWake, error) {
	ino, err := newInotify()
	if err != nil {
		return nil, err
	}
	wd, err := ino.add(dir, dirChanges|unix.IN_ONLYDIR|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF)
	if err != nil {
		ino.close()
		return nil, err
	}
	return &notifyWake{ino: ino, dirWD: wd}, nil
}

// relevant reports whether ev may change what the watcher publishes (see the file comment). It
// also keeps the watch bookkeeping: a removed document folder is forgotten, a removed data
// directory turns this into polling.
func (n *notifyWake) relevant(ev inotifyEvent) bool {
	if ev.mask&unix.IN_Q_OVERFLOW != 0 {
		return true // events were lost: look
	}
	if ev.wd == n.dirWD {
		if ev.mask&(unix.IN_IGNORED|unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0 {
			n.broken = true // the directory itself is gone: no more events will come
			return true
		}
		return ev.mask&unix.IN_ISDIR != 0 || strings.HasSuffix(ev.name, ".content") || strings.HasSuffix(ev.name, ".metadata")
	}
	if n.docDir != "" && ev.wd == n.docWD {
		if ev.mask&unix.IN_IGNORED != 0 {
			n.docDir = "" // the folder went away; follow watches it again if it returns
			return true
		}
		return strings.HasSuffix(ev.name, ".rm")
	}
	return false // from a watch already removed
}

func (n *notifyWake) reportsChanges() bool { return !n.broken }

func (n *notifyWake) follow(docDir string) bool {
	if n.broken || docDir == n.docDir {
		return false
	}
	if n.docDir != "" {
		n.ino.remove(n.docWD)
		n.docDir = ""
	}
	if docDir == "" {
		return false
	}
	// A folder that does not exist yet is fine: its creation wakes the data-directory watch,
	// and the next turn tries again.
	wd, err := n.ino.add(docDir, dirChanges|unix.IN_ONLYDIR)
	if err != nil {
		return false
	}
	n.docDir, n.docWD = docDir, wd
	return true
}

func (n *notifyWake) wait(deadline time.Time) bool {
	for {
		if n.broken {
			time.Sleep(time.Until(deadline))
			return false
		}
		evs, err := n.ino.wait(deadline)
		switch {
		case err != nil:
			fmt.Printf("[page] inotify failed (%v); polling from now on\n", err)
			n.broken = true
		case len(evs) == 0:
			return false // the deadline passed
		default:
			woke := false
			for _, ev := range evs { // every event, so relevant's bookkeeping stays exact
				woke = n.relevant(ev) || woke
			}
			if woke {
				return true
			}
		}
	}
}

// ── the loop ────────────────────────────────────────────────────────────────

// pageLoop is the watcher goroutine's state.
type pageLoop struct {
	w       *pagewatch.Watcher
	wake    pageWake
	dir     string
	every   time.Duration
	feed    *pageFeed
	debug   bool
	lastErr string
}

// turn polls once, publishes a new snapshot, follows the open document, and returns when to
// poll next if no change arrives first. Errors (a file mid-write, no document yet) are logged
// once each, or every time with -debug.
func (l *pageLoop) turn() time.Time {
	b, err := l.w.Poll()
	retry := err != nil
	switch {
	case err != nil:
		if e := err.Error(); e != l.lastErr || l.debug {
			fmt.Printf("[page] %v (retrying)\n", err)
			l.lastErr = e
		}
	case b != nil:
		l.lastErr = ""
		l.feed.set(b)
		fmt.Printf("[page] %s (%d bytes)\n", pageSummary(b), len(b))
	default:
		l.lastErr = ""
	}
	docDir := ""
	if doc := l.w.LocatedDoc(); doc != "" {
		docDir = filepath.Join(l.dir, doc)
	}
	now := time.Now()
	if l.wake.follow(docDir) {
		return now
	}
	return nextDeadline(now, l.wake.reportsChanges(), retry, l.every)
}

// runPageWatch watches xochitl's directory for the life of the process; the first poll runs at
// once.
func runPageWatch(dir string, every time.Duration, feed *pageFeed, debug bool) {
	var wake pageWake
	if n, err := newNotifyWake(dir); err == nil {
		fmt.Printf("[page] watching %s with inotify, retries every %s (read-only)\n", dir, every)
		wake = n
	} else {
		fmt.Printf("[page] inotify unavailable (%v); watching %s every %s (read-only)\n", err, dir, every)
		wake = pollWake{}
	}
	l := &pageLoop{w: &pagewatch.Watcher{Dir: dir}, wake: wake, dir: dir, every: every, feed: feed, debug: debug}
	for {
		l.wake.wait(l.turn())
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
	for {
		b, seq, changed := feed.get()
		if b != nil && seq != sent {
			if err := ws.WriteRaw(b); err != nil {
				ws.sendErr(err)
				return
			}
			sent = seq
		}
		select {
		case <-stop:
			return
		case <-changed:
		}
	}
}
