// Package pagewatch makes the tablet the source of truth for the page: it finds the document
// and page open in xochitl, reads that page's saved `.rm` file (package rmlines) and turns it
// into a `page` message (docs/protocol.md) whenever the file is rewritten or the page changes.
//
// It only ever reads xochitl's data directory. It polls (stat calls once a second, a parse only
// when something changed), which is portable and cheap: xochitl writes a page's `.rm` ~6–10 s
// after the user pauses or when leaving the page, and the open page shows in `<doc>.content`
// within ~1–2 s of a turn (docs/investigations/xochitl-pen-data.md), so inotify would not buy
// visible latency.
package pagewatch

import (
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"codrawer-bridge-native/rmlines"
)

// DefaultDir is xochitl's data directory on the tablet.
const DefaultDir = "/home/root/.local/share/remarkable/xochitl"

// Page size in page units when the file has no SceneInfo (Paper Pro portrait).
const (
	defaultW = 1620
	defaultH = 2160
)

// Location is the open document and page.
type Location struct {
	Doc       string    // document uuid
	Page      string    // page uuid ("" when unknown)
	Title     string    // .metadata visibleName, when readable
	ContentMT time.Time // <doc>.content mtime (when the page turn was saved)
}

// content is the part of <doc>.content this package reads. Current firmware writes
// cPages.lastOpened.value (the open page) and cPages.pages[].id; older files have a plain
// "pages" list.
type content struct {
	CPages struct {
		LastOpened struct {
			Value string `json:"value"`
		} `json:"lastOpened"`
		Pages []struct {
			ID      string `json:"id"`
			Deleted *struct {
				Value int `json:"value"`
			} `json:"deleted"`
		} `json:"pages"`
	} `json:"cPages"`
	Pages []string `json:"pages"`
}

type metadata struct {
	VisibleName    string `json:"visibleName"`
	LastOpenedPage *int   `json:"lastOpenedPage"`
	Deleted        bool   `json:"deleted"`
	Parent         string `json:"parent"`
}

// Locate finds the open document (the newest `<doc>.content`) and its open page
// (cPages.lastOpened; else .metadata lastOpenedPage as an index into the page list; else the
// most recently written `.rm` in the document's folder).
func Locate(dir string) (Location, error) {
	loc, err := newestContent(dir)
	if err != nil {
		return loc, err
	}
	loc.Page, loc.Title, _ = openPage(dir, loc.Doc)
	return loc, nil
}

func newestContent(dir string) (Location, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return Location{}, err
	}
	var best Location
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".content") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(best.ContentMT) {
			best = Location{Doc: strings.TrimSuffix(name, ".content"), ContentMT: info.ModTime()}
		}
	}
	if best.Doc == "" {
		return Location{}, fs.ErrNotExist
	}
	return best, nil
}

// openPage reads the open page and title of doc; guessed reports the newest-.rm fallback.
func openPage(dir, doc string) (page, title string, guessed bool) {
	var c content
	var pages []string
	if b, err := os.ReadFile(filepath.Join(dir, doc+".content")); err == nil && json.Unmarshal(b, &c) == nil {
		page = c.CPages.LastOpened.Value
		for _, p := range c.CPages.Pages {
			if p.Deleted == nil || p.Deleted.Value == 0 {
				pages = append(pages, p.ID)
			}
		}
		if len(pages) == 0 {
			pages = c.Pages
		}
	}
	var m metadata
	if b, err := os.ReadFile(filepath.Join(dir, doc+".metadata")); err == nil && json.Unmarshal(b, &m) == nil {
		title = m.VisibleName
		if page == "" && m.LastOpenedPage != nil && *m.LastOpenedPage >= 0 && *m.LastOpenedPage < len(pages) {
			page = pages[*m.LastOpenedPage]
		}
	}
	if page == "" {
		page, guessed = newestRM(filepath.Join(dir, doc)), true
	}
	return page, title, guessed
}

func newestRM(folder string) string {
	ents, err := os.ReadDir(folder)
	if err != nil {
		return ""
	}
	var best string
	var bestMT time.Time
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".rm") {
			continue
		}
		if info, err := e.Info(); err == nil && info.ModTime().After(bestMT) {
			best, bestMT = strings.TrimSuffix(e.Name(), ".rm"), info.ModTime()
		}
	}
	return best
}

// ── the page message ────────────────────────────────────────────────────────

// Message builds the `page` message for a parsed page (nil: a page with no ink saved yet).
// Coordinates are normalised to the paper: x_norm = (x + W/2) / W (xochitl's x is centred),
// y_norm = y / H; points on a scrolled page can fall outside 0..1 and are kept. Each point is
// [x, y, pressure 0..1, width as a fraction of the page width] (the file's width is in quarter
// pixels). Strokes on hidden layers and erased strokes are left out: the snapshot is the page.
func Message(loc Location, rev int64, page *rmlines.Page) []byte {
	w, h := float64(defaultW), float64(defaultH)
	if page != nil && page.PaperW > 0 && page.PaperH > 0 {
		w, h = float64(page.PaperW), float64(page.PaperH)
	}
	b := make([]byte, 0, 4096)
	b = append(b, `{"t":"page","doc":`...)
	b = appendString(b, loc.Doc)
	b = append(b, `,"page":`...)
	b = appendString(b, loc.Page)
	if loc.Title != "" {
		b = append(b, `,"title":`...)
		b = appendString(b, loc.Title)
	}
	b = append(b, `,"rev":`...)
	b = strconv.AppendInt(b, rev, 10)
	b = append(b, `,"w":`...)
	b = strconv.AppendInt(b, int64(w), 10)
	b = append(b, `,"h":`...)
	b = strconv.AppendInt(b, int64(h), 10)
	b = append(b, `,"strokes":[`...)
	first := true
	if page != nil {
		for _, layer := range page.Layers {
			if !layer.Visible {
				continue
			}
			for _, l := range layer.Lines {
				if len(l.Points) == 0 {
					continue
				}
				if !first {
					b = append(b, ',')
				}
				first = false
				b = appendStroke(b, l, w, h)
			}
		}
	}
	b = append(b, "]}"...)
	return b
}

func appendStroke(b []byte, l *rmlines.Line, w, h float64) []byte {
	c := l.RGBA()
	b = append(b, `{"id":"`...)
	b = append(b, l.ID.String()...)
	b = append(b, `","tool":"`...)
	b = append(b, rmlines.ToolName(l.Tool)...)
	b = append(b, `","color":`...)
	b = strconv.AppendInt(b, int64(l.Color), 10)
	b = append(b, `,"rgba":"#`...)
	for _, v := range []uint8{c.R, c.G, c.B, c.A} {
		b = append(b, hexDigit[v>>4], hexDigit[v&15])
	}
	b = append(b, `","size":`...)
	b = appendNum(b, l.ThicknessScale, 1000)
	if l.Layer != (rmlines.CrdtID{}) {
		b = append(b, `,"layer":"`...)
		b = append(b, l.Layer.String()...)
		b = append(b, '"')
	}
	b = append(b, `,"pts":[`...)
	for i, p := range l.Points {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, '[')
		b = appendNum(b, (float64(p.X)+w/2)/w, 1e5)
		b = append(b, ',')
		b = appendNum(b, float64(p.Y)/h, 1e5)
		b = append(b, ',')
		b = appendNum(b, float64(p.Pressure)/255, 1e3)
		b = append(b, ',')
		b = appendNum(b, float64(p.Width)/4/w, 1e6)
		b = append(b, ']')
	}
	return append(b, "]}"...)
}

const hexDigit = "0123456789abcdef"

// appendNum writes v rounded to 1/scale, shortest form (0.5, 0.12345).
func appendNum(b []byte, v, scale float64) []byte {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return append(b, '0')
	}
	r := math.Round(v*scale) / scale
	if r == 0 {
		r = 0 // no "-0"
	}
	return strconv.AppendFloat(b, r, 'f', -1, 64)
}

func appendString(b []byte, s string) []byte {
	q, _ := json.Marshal(s)
	return append(b, q...)
}

// ── watcher ─────────────────────────────────────────────────────────────────

// Watcher remembers what it last published. Poll is called periodically.
type Watcher struct {
	Dir string

	loc     Location
	guessed bool // loc.Page came from the newest-.rm fallback: re-evaluate every poll
	rmMT    time.Time
	rmSize  int64
	rev     int64
	started bool
}

// Poll returns a new `page` message when the open page changed or its `.rm` was rewritten,
// otherwise nil. A file that cannot be parsed yet (being written) is retried on the next poll.
//
// rev is the time (Unix ms, the tablet's clock — the same clock as stroke timestamps) up to
// which the snapshot is authoritative: the `.rm` mtime for a rewrite of the same page; for a
// page change the later of that and the `.content` write that recorded the turn, so ink drawn
// on the previous page before the turn is not carried over.
func (w *Watcher) Poll() ([]byte, error) {
	loc, err := newestContent(w.Dir)
	if err != nil {
		return nil, err
	}
	// .content and .metadata are re-read only when the document's .content was rewritten.
	if w.started && loc.Doc == w.loc.Doc && loc.ContentMT.Equal(w.loc.ContentMT) && !w.guessed {
		loc.Page, loc.Title = w.loc.Page, w.loc.Title
	} else {
		loc.Page, loc.Title, w.guessed = openPage(w.Dir, loc.Doc)
	}
	if loc.Page == "" {
		return nil, nil
	}
	pageChanged := !w.started || loc.Doc != w.loc.Doc || loc.Page != w.loc.Page
	rmPath := filepath.Join(w.Dir, loc.Doc, loc.Page+".rm")
	var rmMT time.Time
	var rmSize int64
	info, statErr := os.Stat(rmPath)
	if statErr == nil {
		rmMT, rmSize = info.ModTime(), info.Size()
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		return nil, statErr
	}
	if !pageChanged && rmMT.Equal(w.rmMT) && rmSize == w.rmSize {
		w.loc.Title, w.loc.ContentMT = loc.Title, loc.ContentMT
		return nil, nil
	}
	var page *rmlines.Page
	if statErr == nil {
		data, err := os.ReadFile(rmPath)
		if err != nil {
			return nil, err
		}
		if page, err = rmlines.Parse(data); err != nil {
			return nil, err // most likely mid-write: state unchanged, so the next poll retries
		}
	}
	rev := rmMT.UnixMilli()
	if statErr != nil {
		rev = 0
	}
	if pageChanged {
		rev = max(rev, loc.ContentMT.UnixMilli())
	}
	if !pageChanged && rev < w.rev {
		rev = w.rev // never go backwards on one page (clock step, restored file)
	}
	w.loc, w.rmMT, w.rmSize, w.rev, w.started = loc, rmMT, rmSize, rev, true
	return Message(loc, rev, page), nil
}
