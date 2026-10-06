package main

// Tests for when the bridge wakes: the page watcher's inotify path and its poll fallback, the
// page feed's broadcast, the suspend check at writes, and inotify decoding. The Rust engine
// has the same tests (page_watch.rs, bridge.rs, inotify.rs).

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"codrawer-bridge-native/pagewatch"

	"golang.org/x/sys/unix"
)

// fakeWake records the folders it is asked to follow.
type fakeWake struct {
	reports, newWatch bool
	followed          []string
}

func (f *fakeWake) reportsChanges() bool { return f.reports }
func (f *fakeWake) follow(d string) bool {
	f.followed = append(f.followed, d)
	return f.newWatch
}
func (f *fakeWake) wait(time.Time) bool { panic("turn never waits") }

func newTestLoop(dir string, wake pageWake) *pageLoop {
	return &pageLoop{w: &pagewatch.Watcher{Dir: dir}, wake: wake, dir: dir, every: time.Second, feed: newPageFeed()}
}

// about: deadline − before is want, within a little scheduling slack.
func about(deadline, before time.Time, want time.Duration) bool {
	got := deadline.Sub(before)
	return got >= want && got < want+time.Second
}

func TestNextDeadlineFollowsTheWakeSource(t *testing.T) {
	now, every := time.Now(), time.Second
	cases := []struct {
		reports, retry bool
		want           time.Duration
	}{
		{false, false, every}, // polling: every interval
		{false, true, every},
		{true, true, every},       // inotify, but a poll to retry
		{true, false, safetyPoll}, // inotify: rest
	}
	for _, c := range cases {
		if got := nextDeadline(now, c.reports, c.retry, every); !got.Equal(now.Add(c.want)) {
			t.Errorf("nextDeadline(reports=%v, retry=%v) = now+%s, want now+%s", c.reports, c.retry, got.Sub(now), c.want)
		}
	}
}

func TestWithoutInotifyTheLoopPollsEveryInterval(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "d.content"), `{"cPages":{"lastOpened":{"value":"p"}}}`)
	wake := &fakeWake{}
	l := newTestLoop(dir, wake)
	if t0 := time.Now(); !about(l.turn(), t0, time.Second) {
		t.Fatal("polling: want the next poll after the interval")
	}
	if b, _, _ := l.feed.get(); !strings.Contains(string(b), `"page":"p"`) {
		t.Fatalf("not published: %s", b)
	}
	if want := []string{filepath.Join(dir, "d")}; !reflect.DeepEqual(wake.followed, want) {
		t.Fatalf("followed %q, want %q", wake.followed, want)
	}
	if t0 := time.Now(); !about(l.turn(), t0, time.Second) {
		t.Fatal("nothing changed: still every interval")
	}
}

func TestWithInotifyTheLoopRestsUnlessItMustRetry(t *testing.T) {
	dir := t.TempDir()
	wake := &fakeWake{reports: true}
	l := newTestLoop(dir, wake)
	if t0 := time.Now(); !about(l.turn(), t0, time.Second) {
		t.Fatal("no document yet: want a retry after the interval")
	}
	if !reflect.DeepEqual(wake.followed, []string{""}) {
		t.Fatalf("followed %q before any document", wake.followed)
	}
	mustWrite(t, filepath.Join(dir, "d.content"), `{"cPages":{"lastOpened":{"value":"p"}}}`)
	if t0 := time.Now(); !about(l.turn(), t0, safetyPoll) {
		t.Fatal("published: want a rest until an event")
	}
	// a half-written page file is retried on the interval, events or not
	full, err := os.ReadFile(filepath.Join("rmlines", "testdata", "paperpro_calligraphy.rm"))
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(dir, "d", "p.rm"), string(full[:len(full)/2]))
	if t0 := time.Now(); !about(l.turn(), t0, time.Second) {
		t.Fatal("parse error: want a retry after the interval")
	}
}

func TestANewWatchMeansPollAgainAtOnce(t *testing.T) {
	dir := t.TempDir()
	mustWrite(t, filepath.Join(dir, "d.content"), `{}`)
	l := newTestLoop(dir, &fakeWake{reports: true, newWatch: true})
	if d := l.turn(); d.After(time.Now()) {
		t.Fatal("a write may have landed before the watch began: want an immediate poll")
	}
}

func TestNotifyWakesOnPageFilesOnly(t *testing.T) {
	dir := t.TempDir()
	soon := func() time.Time { return time.Now().Add(150 * time.Millisecond) }
	later := func() time.Time { return time.Now().Add(5 * time.Second) }
	if _, err := newNotifyWake(filepath.Join(dir, "missing")); err == nil {
		t.Fatal("a missing directory must fail, so the bridge polls")
	}
	n, err := newNotifyWake(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer n.ino.close()
	expect := func(want bool, deadline time.Time, what string) {
		t.Helper()
		if got := n.wait(deadline); got != want {
			t.Fatalf("%s: woke=%v, want %v", what, got, want)
		}
	}

	mustWrite(t, filepath.Join(dir, "d.pagedata"), "x")
	expect(false, soon(), "xochitl's other files")
	mustWrite(t, filepath.Join(dir, "d.content"), "{}")
	expect(true, later(), ".content written")
	mustWrite(t, filepath.Join(dir, "tmp-file"), "{}") // atomic save: renamed into place
	if err := os.Rename(filepath.Join(dir, "tmp-file"), filepath.Join(dir, "d.metadata")); err != nil {
		t.Fatal(err)
	}
	expect(true, later(), ".metadata renamed into place")

	doc := filepath.Join(dir, "d")
	if n.follow(doc) {
		t.Fatal("the folder does not exist yet")
	}
	if err := os.Mkdir(doc, 0o755); err != nil {
		t.Fatal(err)
	}
	expect(true, later(), "a document folder was created")
	if !n.follow(doc) || n.follow(doc) {
		t.Fatal("follow: want true for a new watch, then false")
	}
	mustWrite(t, filepath.Join(doc, "p.rm"), "x")
	expect(true, later(), ".rm written in the open document")
	if err := os.Mkdir(filepath.Join(doc, "thumbnails"), 0o755); err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(doc, "p-metadata.json"), "{}")
	expect(false, soon(), "other files in the document folder")

	// the folder goes away: forgotten, so a later follow watches it again
	if err := os.RemoveAll(doc); err != nil {
		t.Fatal(err)
	}
	expect(true, later(), "the document folder was removed")
	for n.wait(soon()) {
	}
	if n.docDir != "" || !n.reportsChanges() {
		t.Fatalf("after the folder went away: docDir=%q reports=%v", n.docDir, n.reportsChanges())
	}
}

// Every pump sees every snapshot: the notice is a closed channel, which no pump can swallow
// (the former capacity-1 notify needed a 2 s ticker to cover that case).
func TestPageFeedWakesEveryPump(t *testing.T) {
	f := newPageFeed()
	_, _, a := f.get()
	_, _, b := f.get()
	f.set([]byte("p1"))
	for _, ch := range []<-chan struct{}{a, b} {
		select {
		case <-ch:
		default:
			t.Fatal("a pump was not woken")
		}
	}
	if got, seq, _ := f.get(); string(got) != "p1" || seq != 1 {
		t.Fatalf("get = %q, %d", got, seq)
	}
}

// The check runs at writes, however far apart: only a wall clock that ran ahead of the
// monotonic one counts, never the time between writes itself.
func TestSuspendCheckComparesTheClocksBetweenWrites(t *testing.T) {
	s := func(n int) time.Duration { return time.Duration(n) * time.Second }
	w0 := time.Unix(1_790_000_000, 0)
	m0 := w0
	c := suspendCheck{wall: w0, mono: m0}
	if err := c.resumedAt(w0.Add(s(600)), m0.Add(s(600))); err != nil {
		t.Fatalf("ten idle minutes awake: %v", err)
	}
	if err := c.resumedAt(w0.Add(s(602)), m0.Add(s(601))); err != nil {
		t.Fatalf("within 2 s of drift: %v", err)
	}
	err := c.resumedAt(w0.Add(s(700)), m0.Add(s(611)))
	var r *resumedError
	if !errors.As(err, &r) || err.Error() != "resumed after ~1m28s asleep" {
		t.Fatalf("98 s of wall time in 10 s awake: %v", err)
	}
	if err := c.resumedAt(w0.Add(s(701)), m0.Add(s(612))); err != nil {
		t.Fatalf("reported once: %v", err)
	}
	if err := c.resumedAt(w0, m0.Add(s(613))); err != nil {
		t.Fatalf("a wall clock stepped back is no suspend: %v", err)
	}
}

func TestDecodeInotifyPaddedRecords(t *testing.T) {
	rec := func(wd int32, mask uint32, name string, pad int) []byte {
		b := make([]byte, 16, 16+len(name)+pad)
		binary.NativeEndian.PutUint32(b[0:], uint32(wd))
		binary.NativeEndian.PutUint32(b[4:], mask)
		binary.NativeEndian.PutUint32(b[12:], uint32(len(name)+pad))
		b = append(b, name...)
		return append(b, make([]byte, pad)...)
	}
	var buf []byte
	buf = append(buf, rec(3, unix.IN_MOVED_TO, "d.content", 7)...)
	buf = append(buf, rec(-1, unix.IN_Q_OVERFLOW, "", 0)...)
	buf = append(buf, rec(4, unix.IN_CLOSE_WRITE|unix.IN_ISDIR, "x", 15)...)
	want := []inotifyEvent{
		{3, unix.IN_MOVED_TO, "d.content"},
		{-1, unix.IN_Q_OVERFLOW, ""},
		{4, unix.IN_CLOSE_WRITE | unix.IN_ISDIR, "x"},
	}
	if got := decodeInotify(buf, nil); !reflect.DeepEqual(got, want) {
		t.Fatalf("decode = %+v, want %+v", got, want)
	}
}

func TestInotifyReportsAWriteAndTimesOutWhenQuiet(t *testing.T) {
	dir := t.TempDir()
	ino, err := newInotify()
	if err != nil {
		t.Fatal(err)
	}
	defer ino.close()
	wd, err := ino.add(dir, dirChanges|unix.IN_ONLYDIR)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	if evs, err := ino.wait(t0.Add(50 * time.Millisecond)); err != nil || len(evs) != 0 {
		t.Fatalf("quiet: %v %v", evs, err)
	}
	if time.Since(t0) < 50*time.Millisecond {
		t.Fatal("returned before the deadline")
	}
	mustWrite(t, filepath.Join(dir, "a.content"), "{}")
	evs, err := ino.wait(time.Now().Add(5 * time.Second))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range evs {
		if e.wd == wd && e.name == "a.content" && e.mask&unix.IN_CLOSE_WRITE != 0 {
			return
		}
	}
	t.Fatalf("no close-write event for a.content: %+v", evs)
}

func mustWrite(t *testing.T, path, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}
