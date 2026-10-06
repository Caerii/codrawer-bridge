// Package toolhint reads which tool xochitl's toolbar has selected for the pen tip.
//
// # The problem
//
// The bridge reads the pen through evdev (package pen). That tells the Marker's eraser end
// apart (BTN_TOOL_RUBBER, streamed as brush "eraser"), but not the toolbar. When the user picks
// the toolbar's Eraser and erases with the tip, xochitl cuts ink while the bridge streamed the
// stroke as more ink, so every viewer drew over what the tablet had just erased.
//
// xochitl knows the tool: its pen handler's `lineTool` property. The codrawer-layer XOVI
// extension (bridge/remarkable/xovi/codrawer-layer, "Following the tool") runs inside xochitl,
// follows that property's change signal and writes one line, `<tool> <thickness>`, to
// /run/codrawer/tool by rename when it changes, and touches the file (utime) every 2 s as a
// heartbeat. (Until 2026-10-06 it polled every 100 ms and rewrote the line every second;
// either way a re-read follows any change of mtime or size.)
// The tool word is one of eraser, erase_area, clear_page, select, highlighter, shader, zoom, pen,
// or none when no document is open. The device test that grounds it is in
// docs/investigations/native-erase.md §6.
//
// # Invariants
//
//   - The file is optional. Without the extension (stock xochitl, after a reboot, a hung
//     xochitl) the file is absent or stops being refreshed, and Tool returns "": the bridge then
//     behaves exactly as before.
//   - A line is trusted only while the file's mtime is younger than MaxAge (3 s, three missed
//     heartbeats).
//   - Tool is cheap enough to call at every stroke_begin and hover sample: at most one stat per
//     Every (100 ms), and a read only when the mtime or size changed.
//
// File is not safe for concurrent use; the pen machine's goroutine owns it.
package toolhint

import (
	"os"
	"strings"
	"time"
)

// DefaultPath is where the codrawer-layer extension writes the tool (tmpfs: gone at reboot).
const DefaultPath = "/run/codrawer/tool"

// File follows the tool file at Path. The zero values of MaxAge, Every and Now mean 3 s,
// 100 ms and time.Now.
type File struct {
	Path   string
	MaxAge time.Duration    // trust the line only while the file's mtime is this recent
	Every  time.Duration    // stat the file at most this often
	Now    func() time.Time // clock (tests replace it)

	checked time.Time // when the file was last stat'ed
	mtime   time.Time // mtime and size of the line in tool
	size    int64
	tool    string
}

// Tool returns the selected tool's word ("eraser", "pen", …), or "" when it is unknown: no file,
// a stale file, or "none"/"unknown" in it.
func (f *File) Tool() string {
	now := f.now()
	if f.checked.IsZero() || now.Sub(f.checked) >= f.every() {
		f.checked = now
		f.refresh()
	}
	age := now.Sub(f.mtime)
	if f.tool == "" || age > f.maxAge() || age < -f.maxAge() {
		return ""
	}
	return f.tool
}

// refresh re-reads the file when its mtime or size changed, and forgets it when it is gone.
func (f *File) refresh() {
	st, err := os.Stat(f.Path)
	if err != nil {
		f.tool, f.mtime, f.size = "", time.Time{}, 0
		return
	}
	if st.ModTime().Equal(f.mtime) && st.Size() == f.size {
		return
	}
	f.mtime, f.size = st.ModTime(), st.Size()
	b, err := os.ReadFile(f.Path)
	if err != nil {
		f.tool = ""
		return
	}
	f.tool = Parse(string(b))
}

// Parse returns the tool word of one line of the file: its first field, lower case, or "" for an
// empty line, "none" or "unknown".
func Parse(line string) string {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	w := strings.ToLower(fields[0])
	if w == "none" || w == "unknown" {
		return ""
	}
	return w
}

func (f *File) now() time.Time {
	if f.Now != nil {
		return f.Now()
	}
	return time.Now()
}

func (f *File) every() time.Duration {
	if f.Every > 0 {
		return f.Every
	}
	return 100 * time.Millisecond
}

func (f *File) maxAge() time.Duration {
	if f.MaxAge > 0 {
		return f.MaxAge
	}
	return 3 * time.Second
}
