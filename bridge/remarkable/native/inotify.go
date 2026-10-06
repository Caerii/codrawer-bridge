package main

// A minimal inotify(7) binding: the bridge sleeps until a file it cares about changes instead
// of waking on a timer to look (Rust: src/inotify.rs).
//
// Why: every periodic wakeup costs battery on the Paper Pro, since it pulls the SoC out of deep
// idle, and the page watcher's former 1 s poll also listed xochitl's whole data directory (a
// stat per entry, ~3000 entries on the maintainer's tablet) to find the newest .content. It was
// the largest share of the bridge's idle CPU (docs/investigations/idle-cost.md). inotify lets
// the kernel say when xochitl writes, so an idle tablet costs the page watcher nothing.
//
// The descriptor is non-blocking and wrapped in an *os.File, so the Go runtime parks the
// waiting goroutine in its network poller (epoll) like a socket read: no thread is held in a
// blocking syscall, and the deadline is the file's read deadline.

import (
	"encoding/binary"
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// inotifyEvent is one decoded struct inotify_event: the watch, the IN_* bits and the entry's
// name inside the watched directory ("" for events on the directory itself or an overflow).
type inotifyEvent struct {
	wd   int32
	mask uint32
	name string
}

// dirChanges is what a writer does to a directory entry that matters to a reader: a write
// finished, an entry was renamed in or out (atomic saves), created or deleted.
const dirChanges = unix.IN_CLOSE_WRITE | unix.IN_MOVED_TO | unix.IN_MOVED_FROM | unix.IN_CREATE | unix.IN_DELETE

// inotify is one instance; close releases it and every watch.
type inotify struct {
	f *os.File
}

func newInotify() (*inotify, error) {
	fd, err := unix.InotifyInit1(unix.IN_NONBLOCK | unix.IN_CLOEXEC)
	if err != nil {
		return nil, os.NewSyscallError("inotify_init1", err)
	}
	return &inotify{f: os.NewFile(uintptr(fd), "inotify")}, nil
}

func (n *inotify) close() { _ = n.f.Close() }

// add watches path for mask and returns the watch descriptor. Adding a path twice returns the
// same descriptor (the kernel replaces the mask).
func (n *inotify) add(path string, mask uint32) (int32, error) {
	var wd int
	var err error
	ctlErr := n.raw(func(fd int) { wd, err = unix.InotifyAddWatch(fd, path, mask) })
	if ctlErr != nil {
		return -1, ctlErr
	}
	if err != nil {
		return -1, &os.PathError{Op: "inotify_add_watch", Path: path, Err: err}
	}
	return int32(wd), nil
}

// remove stops a watch; errors are ignored (the watch may be gone with its directory).
func (n *inotify) remove(wd int32) {
	_ = n.raw(func(fd int) { _, _ = unix.InotifyRmWatch(fd, uint32(wd)) })
}

func (n *inotify) raw(op func(fd int)) error {
	rc, err := n.f.SyscallConn()
	if err != nil {
		return err
	}
	return rc.Control(func(fd uintptr) { op(int(fd)) })
}

// wait blocks until events are queued or deadline passes (the zero time: no deadline) and
// returns every event read (none on timeout).
func (n *inotify) wait(deadline time.Time) ([]inotifyEvent, error) {
	if err := n.f.SetReadDeadline(deadline); err != nil {
		return nil, err
	}
	buf := make([]byte, 8192) // many events at once (each is 16 bytes + NAME_MAX + 1 at most)
	k, err := n.f.Read(buf)
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeInotify(buf[:k], nil), nil
}

// decodeInotify appends the struct inotify_event records in buf (wd, mask, cookie, len, then
// len bytes of NUL-padded name; native byte order) to out.
func decodeInotify(buf []byte, out []inotifyEvent) []inotifyEvent {
	for len(buf) >= 16 {
		wd := int32(binary.NativeEndian.Uint32(buf[0:]))
		mask := binary.NativeEndian.Uint32(buf[4:])
		size := int(binary.NativeEndian.Uint32(buf[12:]))
		end := min(16+size, len(buf))
		name := buf[16:end]
		for i, b := range name {
			if b == 0 {
				name = name[:i]
				break
			}
		}
		out = append(out, inotifyEvent{wd: wd, mask: mask, name: string(name)})
		buf = buf[end:]
	}
	return out
}
