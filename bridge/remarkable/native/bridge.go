package main

// Bridge run loop.
//
// Structure (one direction of data, no shared mutable state between stages):
//   - penReaderForever: owns the pen device for the life of the process and parses input_events
//     (with kernel timestamps) into evC, reopening the device on error. After a kernel
//     SYN_DROPPED it resynchronises contact and position from the device state.
//   - penMachineForever: one pen.Machine for the life of the process. It always drains evC, so
//     contact state is never lost while the network is down, and turns events into encoded
//     messages on the outbox (outC). A full outbox skips whole strokes, never single events.
//   - runKeyboardForever (keyboard.go): a keyboard paired to the tablet, producing `key`s.
//   - RunBridgeForever: dials the router and writes the outbox until the socket dies, then
//     reconnects. It also notices a suspend/resume and reconnects at once instead of writing
//     into a socket that died while the tablet slept.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"math/rand"
	"net/url"
	"os"
	"strings"
	"time"

	"codrawer-bridge-native/pen"
)

type BridgeConfig struct {
	WsURL          string
	Brush          string
	Color          string
	InputDevice    string
	BatchHz        int
	MaxBatchPoints int
	NoGrab         bool

	TouchMode         string
	HoverHz           int // cursor messages per second while hovering (0: off)
	PressureThreshold float64
	DistanceThreshold int

	Debug       bool
	DumpEvents  bool
	ListDevices bool

	ProbeSeconds       float64
	PingSeconds        float64
	PongTimeoutSeconds float64

	// Keyboard: "auto" (find a kbd device), "off", or an explicit /dev/input/eventN.
	Keyboard     string
	KeyboardGrab bool

	// TypeReplies: type terminal (`term`) replies into the tablet's focused text
	// field through a virtual keyboard (uinput). TypeCharMs paces the keystrokes.
	TypeReplies bool
	TypeCharMs  int

	// ServeAddr runs the stroke router (package router) in this process, so the glasses app
	// can connect to the tablet directly. RouterOnly skips the pen and keyboard.
	ServeAddr  string
	RouterOnly bool
}

// termMsg is the subset of a `term` broadcast the typer cares about.
type termMsg struct {
	T    string `json:"t"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// outboxSize bounds what is held while the link is down: about 30 s of continuous drawing
// at 60 batches/s. Older ink is delivered first when the link returns.
const outboxSize = 2048

func RunBridgeForever(cfg BridgeConfig) error {
	if cfg.ListDevices {
		for _, d := range listProcInputDevices() {
			fmt.Printf("name=%q handlers=%v\n", d.name, d.handlers)
		}
		return nil
	}

	probeDur := time.Duration(float64(time.Second) * math.Max(0.1, cfg.ProbeSeconds))
	path, err := autoDetectActiveDevice(cfg.InputDevice, cfg.Debug, probeDur)
	if err != nil {
		return err
	}
	fmt.Printf("[bridge] using input device: %s\n", path)

	evC := make(chan pen.Event, 4096)
	readyC := make(chan pen.Ranges, 1)
	go penReaderForever(path, cfg, evC, readyC)
	rng := <-readyC

	outC := make(chan []byte, outboxSize)
	go penMachineForever(cfg, rng, evC, outC)

	pingEvery := time.Duration(float64(time.Second) * math.Max(1, cfg.PingSeconds))
	pongWait := time.Duration(float64(time.Second) * math.Max(2, cfg.PongTimeoutSeconds))
	wsURL := sourceURL(cfg.WsURL)

	reconnectDelay := 500 * time.Millisecond
	maxReconnectDelay := 5 * time.Second

	// Keyboard events flow through this channel regardless of socket state; the
	// per-connection pump below drains it while a socket is up.
	var keyC chan outKey
	if strings.ToLower(strings.TrimSpace(cfg.Keyboard)) != "off" {
		keyC = make(chan outKey, 256)
		go runKeyboardForever(cfg.Keyboard, cfg.KeyboardGrab, cfg.Debug, keyC)
	}

	// Terminal replies typed into the tablet (see uinput.go). Text arrives as
	// coalesced chunks; notes get their own line; the prompt echo is skipped
	// because the user typed it already.
	var typeC chan string
	if cfg.TypeReplies {
		typeC = make(chan string, 1024)
		go typerForever(typeC, time.Duration(max(1, cfg.TypeCharMs))*time.Millisecond, cfg.Debug)
	}
	onMessage := func(data []byte) {
		if typeC == nil {
			return
		}
		var m termMsg
		if err := json.Unmarshal(data, &m); err != nil || m.T != "term" {
			return
		}
		var out string
		switch m.Kind {
		case "text":
			out = m.Text
		case "note":
			if strings.HasPrefix(m.Text, "> ") {
				return
			}
			out = "\n" + m.Text + "\n"
		case "permission", "question":
			out = "\n" + m.Text + "\n"
		default:
			return
		}
		select {
		case typeC <- out:
		default:
		}
	}

	for {
		ws, err := DialWS(context.Background(), wsURL, pingEvery, pongWait, onMessage)
		if err != nil {
			j := time.Duration(rand.Int63n(int64(250 * time.Millisecond)))
			fmt.Printf("[bridge] ws connect error: %v; retrying in %s\n", err, reconnectDelay+j)
			time.Sleep(reconnectDelay + j)
			reconnectDelay = time.Duration(math.Min(float64(maxReconnectDelay), float64(reconnectDelay)*1.7))
			continue
		}

		fmt.Printf("[bridge] connected ws=%s\n", wsURL)
		reconnectDelay = 500 * time.Millisecond

		stopPump := make(chan struct{})
		if keyC != nil {
			go pumpKeys(ws, keyC, stopPump)
		}
		err = writeOutbox(ws, outC)
		close(stopPump)
		ws.Close()
		fmt.Printf("[bridge] disconnected; reconnecting in %s (err=%v)\n", reconnectDelay, err)
		time.Sleep(reconnectDelay)
	}
}

// sourceURL marks the bridge as a pen source: a replaying router (the Go one) then skips the
// page replay, which the bridge has no use for. Routers that do not replay ignore it.
func sourceURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := u.Query()
	if q.Get("replay") == "" {
		q.Set("replay", "0")
		u.RawQuery = q.Encode()
	}
	return u.String()
}

// writeOutbox writes queued messages until the socket fails. A wall clock that jumps ahead of
// the monotonic clock means the tablet was suspended: the socket is presumed dead (its timers
// did not run while asleep) and the caller reconnects immediately.
func writeOutbox(ws *WSConn, outC <-chan []byte) error {
	check := time.NewTicker(time.Second)
	defer check.Stop()
	lastWall, lastMono := time.Now().Round(0), time.Now()
	for {
		select {
		case err := <-ws.Err():
			return err
		case msg := <-outC:
			if err := ws.WriteRaw(msg); err != nil {
				// The message is lost with the socket; the router ends the stroke when we drop.
				return err
			}
		case <-check.C:
			wall, mono := time.Now().Round(0), time.Now()
			if gap := wall.Sub(lastWall) - mono.Sub(lastMono); gap > 2*time.Second {
				return fmt.Errorf("resumed after ~%s asleep", gap.Round(time.Second))
			}
			lastWall, lastMono = wall, mono
		}
	}
}

// penMachineForever runs the stroke state machine for the life of the process.
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

// penReaderForever reads the pen device into evC for the lifetime of the process,
// reopening it on error. The first successful open reports the axis ranges on ready.
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
		parser := &inputParser{}
		resync := false
		emit := func(ev pen.Event) {
			// The machine never blocks, so this only fills if it is wedged; dropping is the
			// lesser evil there, and SYN_DROPPED-style resync below repairs the state.
			select {
			case evC <- ev:
			default:
			}
		}
		for {
			n, err := f.Read(buf)
			if err != nil {
				fmt.Printf("[bridge] pen device read failed (%v); reopening in 2s\n", err)
				break
			}
			parser.feedTimed(buf[:n], func(ev pen.Event) {
				if cfg.DumpEvents {
					fmt.Printf("[ev] type=%d code=%d value=%d t=%d\n", ev.Type, ev.Code, ev.Value, ev.TimeMS)
				}
				if ev.Type == pen.EvSyn && ev.Code == pen.SynDropped {
					// The kernel buffer overflowed: discard up to the next SYN_REPORT, then
					// read the true state from the device (evdev's documented recovery).
					fmt.Printf("[bridge] kernel dropped pen events; resyncing\n")
					resync = true
					return
				}
				if resync {
					if ev.Type == pen.EvSyn && ev.Code == pen.SynReport {
						resync = false
						for _, s := range deviceState(fd, ev.TimeMS) {
							emit(s)
						}
					}
					return
				}
				emit(ev)
			})
		}
		f.Close()
		time.Sleep(2 * time.Second)
	}
}

// deviceState reads contact and position from the device and returns them as events ending in
// a SYN_REPORT, so the machine sees one coherent, current sample.
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

// typerForever owns the virtual keyboard and types whatever arrives on in.
func typerForever(in <-chan string, perChar time.Duration, debug bool) {
	for {
		kb, err := OpenVirtualKeyboard(virtualKeyboardName)
		if err != nil {
			fmt.Printf("[typer] virtual keyboard unavailable (%v); retrying in 10s\n", err)
			time.Sleep(10 * time.Second)
			continue
		}
		fmt.Printf("[typer] virtual keyboard ready\n")
		for s := range in {
			if debug {
				fmt.Printf("[typer] %q\n", s)
			}
			if err := kb.TypeText(s, perChar); err != nil {
				fmt.Printf("[typer] write failed (%v); reopening\n", err)
				break
			}
		}
		kb.Close()
		time.Sleep(2 * time.Second)
	}
}

// pumpKeys forwards keyboard messages over the current socket until stop closes.
// WSConn writes are mutex-protected, so this is safe next to the outbox writer.
// A write failure is reported to the socket's error channel so the writer reconnects.
func pumpKeys(ws *WSConn, keyC <-chan outKey, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case k := <-keyC:
			if err := ws.WriteJSON(k); err != nil {
				ws.sendErr(err)
				return
			}
		}
	}
}
