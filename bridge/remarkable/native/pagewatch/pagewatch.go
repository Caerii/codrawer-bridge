// Package pagewatch makes the tablet the source of truth for the page: it finds the document and
// page open in xochitl, reads that page's saved `.rm` file (package rmlines) and turns it into a
// `page` message (docs/protocol.md, ADR 008) whenever the file is rewritten or the page changes.
//
// # Facts it rests on
//
// Measured on the Paper Pro (docs/investigations/xochitl-pen-data.md, "Measured on the device"):
//
//   - xochitl writes a page's `.rm` when the user pauses (~6–10 s idle) or leaves the page, never
//     per stroke. The file is therefore a reconciliation source a few seconds behind the live pen
//     stream, not a replacement for it.
//   - A page turn shows in `<doc>.content` (cPages.lastOpened) within ~1–2 s.
//   - The written page holds exactly the strokes the bridge streamed for it, with the tool,
//     colour and per-point width the pen stream cannot know.
//
// Because the file lags by seconds anyway, the watcher polls: stat calls once a second (the
// bridge's PAGE_POLL_MS), and a read and parse only when something changed. That is portable and
// cheap, and inotify would not buy visible latency. It only ever reads xochitl's data directory;
// the layout is xochitl's private format, which is why the bridge runs the watcher only on an OS
// version boot.sh lists as tested (page_watch.go).
//
// # Data flow
//
//	xochitl dir ──stat──▶ Watcher.Poll ──(changed?)──▶ rmlines.Parse ──▶ Message ──▶ bridge outbox
//	  <doc>.content        Location (doc, page, title)                     `page` JSON
//	  <doc>.metadata
//	  <doc>/<page>.rm
//
// Reading order: locate.go (which page is open) → message.go (the `page` JSON) → this file (when
// to send one, and its rev).
package pagewatch

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"codrawer-bridge-native/rmlines"
)

// DefaultDir is xochitl's data directory on the tablet.
const DefaultDir = "/home/root/.local/share/remarkable/xochitl"

// Watcher remembers what it last published so that Poll sends only changes. The zero value with
// Dir set is ready; it is not safe for concurrent use.
type Watcher struct {
	Dir string // xochitl's data directory (read-only)

	loc     Location
	guessed bool // loc.Page came from the newest-.rm fallback: re-evaluate every poll
	rmMT    time.Time
	rmSize  int64
	rev     int64
	started bool
}

// rmFile is what a stat says about the open page's `.rm`. A page with no ink saved yet has no
// file; it is still published, as an empty page.
type rmFile struct {
	path   string
	exists bool
	mt     time.Time
	size   int64
}

// Poll returns a new `page` message when the open page changed or its `.rm` was rewritten,
// otherwise nil. A file that cannot be parsed yet (being written) is an error and leaves the
// watcher's state unchanged, so the next poll retries it.
func (w *Watcher) Poll() ([]byte, error) {
	loc, err := w.locate()
	if err != nil {
		return nil, err
	}
	if loc.Page == "" {
		return nil, nil
	}
	pageChanged := !w.started || loc.Doc != w.loc.Doc || loc.Page != w.loc.Page
	rm, err := statRM(w.Dir, loc)
	if err != nil {
		return nil, err
	}
	if !pageChanged && rm.mt.Equal(w.rmMT) && rm.size == w.rmSize {
		w.loc.Title, w.loc.ContentMT = loc.Title, loc.ContentMT
		return nil, nil
	}
	var page *rmlines.Page
	if rm.exists {
		data, err := os.ReadFile(rm.path)
		if err != nil {
			return nil, err
		}
		if page, err = rmlines.Parse(data); err != nil {
			return nil, err // most likely mid-write: state unchanged, so the next poll retries
		}
	}
	rev := w.revFor(loc, rm, pageChanged)
	w.loc, w.rmMT, w.rmSize, w.rev, w.started = loc, rm.mt, rm.size, rev, true
	return Message(loc, rev, page), nil
}

// locate finds the open document and page. The document's .content and .metadata are re-read
// only when its .content was rewritten (or the page was a guess, which may change at any time).
func (w *Watcher) locate() (Location, error) {
	loc, err := newestContent(w.Dir)
	if err != nil {
		return loc, err
	}
	if w.started && loc.Doc == w.loc.Doc && loc.ContentMT.Equal(w.loc.ContentMT) && !w.guessed {
		loc.Page, loc.Title = w.loc.Page, w.loc.Title
	} else {
		loc.Page, loc.Title, w.guessed = openPage(w.Dir, loc.Doc)
	}
	return loc, nil
}

// statRM stats the open page's `.rm`. A missing file is not an error.
func statRM(dir string, loc Location) (rmFile, error) {
	f := rmFile{path: filepath.Join(dir, loc.Doc, loc.Page+".rm")}
	info, err := os.Stat(f.path)
	switch {
	case err == nil:
		f.exists, f.mt, f.size = true, info.ModTime(), info.Size()
	case !errors.Is(err, fs.ErrNotExist):
		return f, err
	}
	return f, nil
}

// revFor is the time (Unix ms, the tablet's clock — the same clock as stroke timestamps) up to
// which the snapshot is authoritative: the `.rm` mtime (0 when there is no file) for a rewrite of
// the same page; for a page change the later of that and the `.content` write that recorded the
// turn, so ink drawn on the previous page before the turn is not carried over. On one page rev
// never goes backwards (a clock step, a restored file).
func (w *Watcher) revFor(loc Location, rm rmFile, pageChanged bool) int64 {
	rev := int64(0)
	if rm.exists {
		rev = rm.mt.UnixMilli()
	}
	if pageChanged {
		rev = max(rev, loc.ContentMT.UnixMilli())
	}
	if !pageChanged && rev < w.rev {
		rev = w.rev
	}
	return rev
}
