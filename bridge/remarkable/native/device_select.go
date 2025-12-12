package main

// Input device selection helpers.
//
// On reMarkable/Codex, pen/touch devices appear as /dev/input/eventX.
// We support:
// - printing /proc/bus/input/devices (for debugging)
// - "probing" each event node for short activity to auto-select the active device

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
)

type inputDeviceInfo struct {
	name     string
	handlers []string
}

func listProcInputDevices() []inputDeviceInfo {
	b, err := os.ReadFile("/proc/bus/input/devices")
	if err != nil {
		return nil
	}
	blocks := strings.Split(string(b), "\n\n")
	var out []inputDeviceInfo
	for _, blk := range blocks {
		info := inputDeviceInfo{}
		for _, line := range strings.Split(blk, "\n") {
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

// pickInputDevicePath uses /proc/bus/input/devices heuristic only (name-based).
func pickInputDevicePath(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}

	// Heuristic: scan /proc/bus/input/devices and prefer stylus-ish names.
	b, err := os.ReadFile("/proc/bus/input/devices")
	if err == nil {
		blocks := strings.Split(string(b), "\n\n")
		bestScore := int64(-1)
		bestPath := ""
		for _, blk := range blocks {
			var name string
			var handlers []string
			for _, line := range strings.Split(blk, "\n") {
				if strings.HasPrefix(line, "N: Name=") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 {
						name = strings.Trim(parts[1], " \"")
					}
				}
				if strings.HasPrefix(line, "H: Handlers=") {
					parts := strings.SplitN(line, "=", 2)
					if len(parts) == 2 {
						handlers = strings.Fields(parts[1])
					}
				}
			}
			ev := ""
			for _, h := range handlers {
				if strings.HasPrefix(h, "event") {
					ev = h
					break
				}
			}
			if ev == "" {
				continue
			}
			score := int64(0)
			ln := strings.ToLower(name)
			if strings.Contains(ln, "stylus") || strings.Contains(ln, "wacom") || strings.Contains(ln, "pen") || strings.Contains(ln, "marker") {
				score += 10
			}
			if strings.Contains(ln, "touch") {
				score += 2
			}
			path := "/dev/input/" + ev
			if score > bestScore {
				bestScore = score
				bestPath = path
			}
		}
		if bestPath != "" {
			return bestPath, nil
		}
	}

	// Fallback: first /dev/input/event*
	matches, _ := filepath.Glob("/dev/input/event*")
	if len(matches) == 0 {
		return "", errors.New("no /dev/input/event* devices found")
	}
	return matches[0], nil
}

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

func (p devProbe) score() int {
	// Prefer X/Y/pressure/distance + tool keys. Any activity beats none.
	return p.any + 5*p.absX + 5*p.absY + 8*p.absP + 8*p.absD + 8*p.btnTouch + 6*p.btnPen + 6*p.btnRubber
}

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
		parser.feed(buf[:n], func(etype uint16, code uint16, _value int32) {
			out.any++
			switch etype {
			case EV_ABS:
				switch code {
				case ABS_X:
					out.absX++
				case ABS_Y:
					out.absY++
				case ABS_PRESSURE:
					out.absP++
				case ABS_DISTANCE:
					out.absD++
				}
			case EV_KEY:
				switch code {
				case BTN_TOUCH:
					out.btnTouch++
				case BTN_TOOL_PEN:
					out.btnPen++
				case BTN_TOOL_RUBBER:
					out.btnRubber++
				}
			}
		})
	}
	return out, nil
}

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


