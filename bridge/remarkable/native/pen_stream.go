package main

// The pen pipeline: device → events → pen.Machine → outbox.
//
// Two goroutines, both for the life of the process. The reader owns the device file and does
// nothing but parse; the machine owns all stroke state and never blocks (its Emit refuses when
// the outbox is full). Between them sits evC, a buffer of 4096 events, which fills only if the
// machine is wedged.
//
// Device facts (CLAUDE.md, "Facts that cost hours"): the Paper Pro's pen is /dev/input/event2
// (the Elan marker); the auto-probe picks event0, the power key, so bridge.env names the device.
// The device is read without EVIOCGRAB by default (NO_GRAB=1), so xochitl keeps drawing the ink.

import (
	"fmt"
	"os"
	"time"

	"codrawer-bridge-native/pen"
)

// penReaderForever reads the pen device into evC for the lifetime of the process, reopening it
// 2 s after any error. The first successful open reports the axis ranges on ready.
func penReaderForever(path string, cfg BridgeConfig, evC chan<- pen.Event, ready chan<- pen.Ranges) {
	first := true
	buf := make([]byte, 64*24) // reused: up to 64 events per read, no garbage per read
	for {
		f, err := os.Open(path)
		if err != nil {
			fmt.Printf("[bridge] pen device open failed (%v); retrying in 2s\n", err)
			time.Sleep(2 * time.Second)
			continue
		}
		fd := int(f.Fd())
		if !cfg.NoGrab {
			tryGrab(fd)
		}
		if first {
			ready <- getRanges(fd)
			first = false
		}
		readPen(f, fd, buf, cfg.DumpEvents, evC)
		f.Close()
		time.Sleep(2 * time.Second)
	}
}

// readPen parses events from one open device until a read fails.
func readPen(f *os.File, fd int, buf []byte, dump bool, evC chan<- pen.Event) {
	parser := &inputParser{}
	var rs resyncer
	emit := func(ev pen.Event) {
		// The machine never blocks, so this only fills if it is wedged; dropping is the lesser
		// evil there, and the SYN_DROPPED-style resync repairs the state.
		select {
		case evC <- ev:
		default:
		}
	}
	state := func(tsMS int64) []pen.Event { return deviceState(fd, tsMS) }
	for {
		n, err := f.Read(buf)
		if err != nil {
			fmt.Printf("[bridge] pen device read failed (%v); reopening in 2s\n", err)
			return
		}
		parser.feed(buf[:n], func(ev pen.Event) {
			if dump {
				fmt.Printf("[ev] type=%d code=%d value=%d t=%d\n", ev.Type, ev.Code, ev.Value, ev.TimeMS)
			}
			rs.handle(ev, emit, state)
		})
	}
}

// resyncer implements evdev's documented recovery from SYN_DROPPED (the kernel's event buffer
// overflowed): discard everything up to the next SYN_REPORT, then read the true state from the
// device and deliver it as one sample. Without it the machine could miss a pen-up.
type resyncer struct {
	dropping bool
}

// handle passes ev on to emit, or swallows it while recovering; state reads the device.
func (r *resyncer) handle(ev pen.Event, emit func(pen.Event), state func(tsMS int64) []pen.Event) {
	if ev.Type == pen.EvSyn && ev.Code == pen.SynDropped {
		fmt.Printf("[bridge] kernel dropped pen events; resyncing\n")
		r.dropping = true
		return
	}
	if r.dropping {
		if ev.Type == pen.EvSyn && ev.Code == pen.SynReport {
			r.dropping = false
			for _, s := range state(ev.TimeMS) {
				emit(s)
			}
		}
		return
	}
	emit(ev)
}

// deviceState reads contact and position from the device and returns them as events ending in
// a SYN_REPORT, so the machine sees one coherent, current sample. Axes or keys that cannot be
// read are left out.
func deviceState(fd int, tsMS int64) []pen.Event {
	var evs []pen.Event
	if keys, err := getKeyBits(fd); err == nil {
		for _, k := range []uint16{pen.BtnToolPen, pen.BtnToolRubber, pen.BtnTouch} {
			v := int32(0)
			if keys[k/8]&(1<<(k%8)) != 0 {
				v = 1
			}
			evs = append(evs, pen.Event{Type: pen.EvKey, Code: k, Value: v, TimeMS: tsMS})
		}
	}
	for _, a := range []uint16{pen.AbsX, pen.AbsY, pen.AbsPressure, pen.AbsDistance} {
		if info, err := getAbsInfo(fd, int(a)); err == nil {
			evs = append(evs, pen.Event{Type: pen.EvAbs, Code: a, Value: info.Value, TimeMS: tsMS})
		}
	}
	return append(evs, pen.Event{Type: pen.EvSyn, Code: pen.SynReport, TimeMS: tsMS})
}

// penMachineForever runs the stroke state machine for the life of the process: every event goes
// through it, and a timer flushes a pending batch when its window closes.
func penMachineForever(cfg BridgeConfig, rng pen.Ranges, evC <-chan pen.Event, outC chan<- []byte) {
	m := pen.New(pen.Config{
		Brush:             cfg.Brush,
		Color:             cfg.Color,
		TouchMode:         cfg.TouchMode,
		PressureThreshold: cfg.PressureThreshold,
		DistanceThreshold: cfg.DistanceThreshold,
		FlushEvery:        time.Second / time.Duration(max(1, cfg.BatchHz)),
		MaxBatch:          cfg.MaxBatchPoints,
		HoverEvery:        hoverEvery(cfg.HoverHz),
	}, rng, func(msg []byte) bool {
		select {
		case outC <- msg:
			return true
		default:
			return false
		}
	})
	m.OnStroke = func(bool) { holdAwake() }

	timer := time.NewTimer(time.Hour)
	timer.Stop()
	armed := false
	debugTick := time.Now()
	for {
		select {
		case ev := <-evC:
			m.Handle(ev)
		case <-timer.C:
			armed = false
			m.Flush(false)
		}
		// Arm the batch timer only while points are waiting: no wakeups while the pen is idle.
		if pending, due := m.Pending(); pending && !armed {
			wait := time.Until(due)
			if wait < 0 {
				wait = 0
			}
			timer.Reset(wait)
			armed = true
		}
		if cfg.Debug && time.Since(debugTick) > 2*time.Second {
			debugTick = time.Now()
			fmt.Printf("[bridge] stats touching=%v strokes=%d skipped=%d outbox=%d\n", m.Touching(), m.Strokes(), m.LostStrokes(), len(outC))
		}
	}
}

// hoverEvery converts HOVER_HZ to the machine's pacing interval (0 disables hover).
func hoverEvery(hz int) time.Duration {
	if hz <= 0 {
		return 0
	}
	return time.Second / time.Duration(hz)
}

// holdAwake keeps the tablet out of autosleep for 3 s after pen activity, so the last stroke
// leaves the radio before the system suspends. A timed kernel wake lock expires by itself.
func holdAwake() {
	_ = os.WriteFile("/sys/power/wake_lock", []byte("codrawer-pen 3000000000"), 0)
}
