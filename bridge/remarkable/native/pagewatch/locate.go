package pagewatch

// Which page is open.
//
// xochitl keeps, per document, `<doc>.content` (JSON: the page list and, on current firmware,
// cPages.lastOpened, the open page), `<doc>.metadata` (JSON: visibleName, lastOpenedPage as an
// index) and a folder `<doc>/` with one `<page>.rm` per page that has ink
// (docs/investigations/xochitl-pen-data.md §1, §3). The open document is the one whose .content
// was written last, since xochitl rewrites it on every page turn. The open page is found by the
// most reliable source available, in order:
//
//  1. cPages.lastOpened.value in .content;
//  2. .metadata lastOpenedPage as an index into the (non-deleted) page list;
//  3. the most recently written `.rm` in the document's folder (a guess, re-checked every poll).

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
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

// metadata is the part of <doc>.metadata this package reads.
type metadata struct {
	VisibleName    string `json:"visibleName"`
	LastOpenedPage *int   `json:"lastOpenedPage"`
	Deleted        bool   `json:"deleted"`
	Parent         string `json:"parent"`
}

// Locate finds the open document (the newest `<doc>.content`) and its open page (see the order
// above). It fails only when no document exists.
func Locate(dir string) (Location, error) {
	loc, err := newestContent(dir)
	if err != nil {
		return loc, err
	}
	loc.Page, loc.Title, _ = openPage(dir, loc.Doc)
	return loc, nil
}

// newestContent returns the document whose .content was written last, with that mtime; Page and
// Title are left empty. fs.ErrNotExist means there is no document at all.
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
// Unreadable or malformed JSON simply moves on to the next source.
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

// newestRM returns the page id of the most recently written `.rm` in folder, or "".
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
