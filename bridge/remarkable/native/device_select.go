package main

// Finding input devices.
//
// The kernel lists every input device in /proc/bus/input/devices, one blank-line-separated block
// per device with its name (N:), bus (I:) and handlers (H:, e.g. "kbd event3"). The keyboard is
// found from that list (keyboard.go). The pen is found by probing: each /dev/input/event* is read
// for a short window (-probe-seconds) while the user draws, and the node with the most pen-like
// activity wins.
//
// On the Paper Pro the probe is not to be trusted: it picks event0, the power key, so the boot
// configuration names the pen (INPUT_DEVICE=/dev/input/event2, bridge.env.example). An explicit
// device always wins over probing.

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"codrawer-bridge-native/pen"
)

// inputDeviceInfo is one block of /proc/bus/input/devices.
type inputDeviceInfo struct {
	name     string
	handlers []string // e.g. ["kbd", "event3"]
	virtual  bool     // a uinput device (bus 0x06), e.g. a typist injecting text
}

// listProcInputDevices parses /proc/bus/input/devices (nil if unreadable).
func listProcInputDevices() []inputDeviceInfo {
	b, err := os.ReadFile("/proc/bus/input/devices")
	if err != nil {
		return nil
	}
	return parseProcInputDevices(string(b))
}

// parseProcInputDevices parses the text of /proc/bus/input/devices. Blocks with neither a name
// nor handlers are skipped.
func parseProcInputDevices(text string) []inputDeviceInfo {
	var out []inputDeviceInfo
	for _, blk := range strings.Split(text, "\n\n") {
		info := inputDeviceInfo{}
		for _, line := range strings.Split(blk, "\n") {
			// "I: Bus=0006 Vendor=…": bus 0x06 is BUS_VIRTUAL (uinput devices)
			if strings.HasPrefix(line, "I: Bus=") {
				info.virtual = strings.HasPrefix(strings.TrimPrefix(line, "I: Bus="), "0006")
			}
			if strings.HasPrefix(line, "N: Name=") {
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					info.name = strings.Trim(parts[1], " \"")
				}
			}
			if strings.HasPrefix(line, "H: Handlers=") {
				parts := strings.SplitN(line, "=", 2)
				if len(parts) == 2 {
					info.handlers = strings.Fields(parts[1])
				}
			}
		}
		if info.name != "" || len(info.handlers) > 0 {
			out = append(out, info)
		}
	}
	return out
}

// ── probing for the pen ─────────────────────────────────────────────────────

// devProbe counts the events one device produced during its probe window.
type devProbe struct {
	path      string
	absX      int
	absY      int
	absP      int
	absD      int
	btnTouch  int
	btnPen    int
	btnRubber int
	any       int
}

// score prefers X/Y/pressure/distance and the stylus keys; any activity beats none.
func (p devProbe) score() int {
	return p.any + 5*p.absX + 5*p.absY + 8*p.absP + 8*p.absD + 8*p.btnTouch + 6*p.btnPen + 6*p.btnRubber
}

// count tallies one event.
func (p *devProbe) count(ev pen.Event) {
	p.any++
	switch ev.Type {
	case pen.EvAbs:
		switch ev.Code {
		case pen.AbsX:
			p.absX++
		case pen.AbsY:
			p.absY++
		case pen.AbsPressure:
			p.absP++
		case pen.AbsDistance:
			p.absD++
		}
	case pen.EvKey:
		switch ev.Code {
		case pen.BtnTouch:
			p.btnTouch++
		case pen.BtnToolPen:
			p.btnPen++
		case pen.BtnToolRubber:
			p.btnRubber++
		}
	}
}

// probeDevice reads one device non-blocking for dur and counts what it produced.
func probeDevice(path string, dur time.Duration) (devProbe, error) {
	out := devProbe{path: path}
	f, err := os.Open(path)
	if err != nil {
		return out, err
	}
	defer f.Close()
	fd := int(f.Fd())

	if err := unix.SetNonblock(fd, true); err != nil {
		return out, err
	}

	reader := bufio.NewReaderSize(f, 4096)
	parser := &inputParser{}
	deadline := time.Now().Add(dur)

	for time.Now().Before(deadline) {
		pfd := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		_, _ = unix.Poll(pfd, 50)
		if pfd[0].Revents&unix.POLLIN == 0 {
			continue
		}
		buf := make([]byte, 4096)
		n, err := reader.Read(buf)
		if err != nil || n == 0 {
			continue
		}
		parser.feed(buf[:n], out.count)
	}
	return out, nil
}

// autoDetectActiveDevice returns explicit if set, else probes every /dev/input/event* in name
// order for probeDur each and returns the best-scoring one (on a tie, or if nothing moved, the
// first that opened; matches[0] if none did).
func autoDetectActiveDevice(explicit string, debug bool, probeDur time.Duration) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	matches, _ := filepath.Glob("/dev/input/event*")
	if len(matches) == 0 {
		return "", errors.New("no /dev/input/event* devices found")
	}
	sort.Strings(matches)

	bestScore := -1
	best := devProbe{path: matches[0]}
	for _, p := range matches {
		pr, err := probeDevice(p, probeDur)
		if err != nil {
			continue
		}
		s := pr.score()
		if debug {
			fmt.Printf("[bridge] probe %s score=%d any=%d x=%d y=%d p=%d d=%d touch=%d pen=%d rubber=%d\n",
				p, s, pr.any, pr.absX, pr.absY, pr.absP, pr.absD, pr.btnTouch, pr.btnPen, pr.btnRubber)
		}
		if s > bestScore {
			bestScore = s
			best = pr
		}
	}
	if debug {
		fmt.Printf("[bridge] selected %s score=%d\n", best.path, best.score())
	}
	return best.path, nil
}
