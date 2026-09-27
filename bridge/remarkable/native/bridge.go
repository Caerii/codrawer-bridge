package main

// Bridge run loop + stroke state machine.
//
// This file is intentionally verbose and heavily commented because it is the "business logic"
// for turning Linux input events into protocol messages.
//
// Structure:
//   - penReaderForever: a goroutine that owns the pen device for the life of the process and
//     parses input_events into a channel (reopening the device on error).
//   - runKeyboardForever (keyboard.go): the same for a keyboard, producing `key` messages.
//   - RunBridgeForever: connects the WebSocket, runs runOnce until the socket dies, reconnects.
//   - runOnce: the stroke state machine. It selects on pen events, socket errors and a flush
//     timer, so a dead socket is noticed even while the pen is idle. (The earlier version only
//     checked the socket after a pen read returned, so an idle tablet never reconnected and
//     keyboard input pumped into a dead socket was dropped.)

import (
	"bufio"
	"context"
	"fmt"
	"math"
	"math/rand"
	"os"
	"strings"
	"sync/atomic"
	"time"
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
}

type outStrokeBegin struct {
	T     string `json:"t"`
	ID    string `json:"id"`
	Layer string `json:"layer"`
	Brush string `json:"brush"`
	Color string `json:"color,omitempty"`
	TS    int64  `json:"ts"`
}

type outStrokePts struct {
	T   string      `json:"t"`
	ID  string      `json:"id"`
	Pts [][]float64 `json:"pts"`
}

type outStrokeEnd struct {
	T  string `json:"t"`
	ID string `json:"id"`
	TS int64  `json:"ts"`
}

// rawEvent is one parsed Linux input_event from the pen device.
type rawEvent struct {
	etype uint16
	code  uint16
	value int32
}

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

	// The pen reader owns the device for the whole process; runOnce consumes its events.
	evC := make(chan rawEvent, 4096)
	readyC := make(chan absRanges, 1)
	go penReaderForever(path, cfg, evC, readyC)
	rng := <-readyC

	flushEvery := time.Second / time.Duration(max(1, cfg.BatchHz))
	pingEvery := time.Duration(float64(time.Second) * math.Max(1, cfg.PingSeconds))
	pongWait := time.Duration(float64(time.Second) * math.Max(2, cfg.PongTimeoutSeconds))

	reconnectDelay := 500 * time.Millisecond
	maxReconnectDelay := 5 * time.Second

	var strokesSent atomic.Int64

	// Keyboard events flow through this channel regardless of socket state; the
	// per-connection pump below drains it while a socket is up.
	var keyC chan outKey
	if strings.ToLower(strings.TrimSpace(cfg.Keyboard)) != "off" {
		keyC = make(chan outKey, 256)
		go runKeyboardForever(cfg.Keyboard, cfg.KeyboardGrab, cfg.Debug, keyC)
	}

	for {
		ctx := context.Background()
		ws, err := DialWS(ctx, cfg.WsURL, pingEvery, pongWait)
		if err != nil {
			j := time.Duration(rand.Int63n(int64(250 * time.Millisecond)))
			fmt.Printf("[bridge] ws connect error: %v; retrying in %s\n", err, reconnectDelay+j)
			time.Sleep(reconnectDelay + j)
			reconnectDelay = time.Duration(math.Min(float64(maxReconnectDelay), float64(reconnectDelay)*1.7))
			continue
		}

		fmt.Printf("[bridge] connected ws=%s\n", cfg.WsURL)
		reconnectDelay = 500 * time.Millisecond

		stopPump := make(chan struct{})
		if keyC != nil {
			go pumpKeys(ws, keyC, stopPump)
		}
		err = runOnce(evC, rng, cfg, ws, flushEvery, &strokesSent)
		close(stopPump)
		ws.Close()
		fmt.Printf("[bridge] disconnected; strokes_sent=%d; reconnecting in %s (err=%v)\n", strokesSent.Load(), reconnectDelay, err)
		time.Sleep(reconnectDelay)
	}
}

// penReaderForever reads the pen device into evC for the lifetime of the process,
// reopening it on error. The first successful open reports the axis ranges on ready.
func penReaderForever(path string, cfg BridgeConfig, evC chan<- rawEvent, ready chan<- absRanges) {
	first := true
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
		reader := bufio.NewReaderSize(f, 4096)
		parser := &inputParser{}
		for {
			chunk := make([]byte, 4096)
			n, err := reader.Read(chunk)
			if err != nil {
				fmt.Printf("[bridge] pen device read failed (%v); reopening in 2s\n", err)
				break
			}
			parser.feed(chunk[:n], func(etype uint16, code uint16, value int32) {
				select {
				case evC <- rawEvent{etype, code, value}:
				default:
					// consumer stalled (no socket); drop rather than block the device
				}
			})
		}
		f.Close()
		time.Sleep(2 * time.Second)
	}
}

// pumpKeys forwards keyboard messages over the current socket until stop closes.
// WSConn.WriteJSON is mutex-protected, so this is safe next to the stroke writer.
// A write failure is reported to the socket's error channel so runOnce reconnects.
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

func runOnce(evC <-chan rawEvent, rng absRanges, cfg BridgeConfig, ws *WSConn, flushEvery time.Duration, strokesSent *atomic.Int64) error {
	// Input state (raw)
	var (
		xRaw, yRaw, pRaw, dRaw int32
		hasX, hasY             bool
	)

	// Tool + brush state
	var (
		btnTouchDown   bool
		toolPenDown    bool
		toolRubberDown bool
		curBrush       = cfg.Brush
	)

	// Stroke state
	var (
		touching     bool
		strokeID     string
		batch        [][]float64
		lastFlush    = time.Now()
		lastAnyEvent = time.Now()

		// Used to drop micro-jitter after normalization.
		lastNormX    float64
		lastNormY    float64
		haveLastNorm bool
	)

	sendPts := func(force bool) error {
		if strokeID == "" || len(batch) == 0 {
			return nil
		}
		if !force && time.Since(lastFlush) < flushEvery && len(batch) < cfg.MaxBatchPoints {
			return nil
		}
		if err := ws.WriteJSON(outStrokePts{T: "stroke_pts", ID: strokeID, Pts: batch}); err != nil {
			return err
		}
		batch = nil
		lastFlush = time.Now()
		return nil
	}

	handle := func(etype uint16, code uint16, value int32) {
		lastAnyEvent = time.Now()
		if cfg.DumpEvents {
			fmt.Printf("[ev] type=%d code=%d value=%d\n", etype, code, value)
		}

		switch etype {
		case EV_ABS:
			switch code {
			case ABS_X:
				xRaw = value
				hasX = true
			case ABS_Y:
				yRaw = value
				hasY = true
			case ABS_PRESSURE:
				pRaw = value
			case ABS_DISTANCE:
				dRaw = value
			}

		case EV_KEY:
			switch code {
			case BTN_TOUCH:
				btnTouchDown = value != 0
			case BTN_TOOL_PEN:
				toolPenDown = value != 0
			case BTN_TOOL_RUBBER:
				toolRubberDown = value != 0
			}

			// Maintain current brush based on current tool state.
			if toolRubberDown {
				curBrush = "eraser"
			} else {
				curBrush = cfg.Brush
			}

		case EV_SYN:
			if code != SYN_REPORT {
				return
			}

			// Decide "down" based on chosen mode, using the most recent state.
			mode := strings.ToLower(strings.TrimSpace(cfg.TouchMode))
			if mode == "" {
				mode = "auto"
			}

			// Auto heuristic: prefer BTN_TOUCH when available, else pressure, else distance, else tool.
			if mode == "auto" {
				if btnTouchDown {
					mode = "btn"
				} else {
					// We treat "pressure mode" as a threshold on the normalized pressure value,
					// but only if pressure range is meaningful.
					mode = "pressure"
				}
			}

			var down bool
			switch mode {
			case "btn":
				down = btnTouchDown
			case "pressure":
				down = norm(pRaw, rng.pMin, rng.pMax) > cfg.PressureThreshold
			case "distance":
				down = int(dRaw) <= cfg.DistanceThreshold
			case "tool":
				down = toolPenDown || toolRubberDown
			default:
				down = btnTouchDown
			}

			// Start/end strokes on transitions.
			if down && !touching {
				touching = true
				strokeID = fmt.Sprintf("u_%x", time.Now().UnixNano())
				batch = nil
				haveLastNorm = false
				lastFlush = time.Now()
				_ = ws.WriteJSON(outStrokeBegin{T: "stroke_begin", ID: strokeID, Layer: "user", Brush: curBrush, Color: cfg.Color, TS: nowMS()})
			} else if !down && touching {
				touching = false
				_ = sendPts(true)
				_ = ws.WriteJSON(outStrokeEnd{T: "stroke_end", ID: strokeID, TS: nowMS()})
				strokesSent.Add(1)
				strokeID = ""
				return
			}

			// Emit one coherent point per SYN_REPORT (prevents X/Y desync artifacts).
			if touching && strokeID != "" && hasX && hasY {
				x := norm(xRaw, rng.xMin, rng.xMax)
				y := norm(yRaw, rng.yMin, rng.yMax)
				p := norm(pRaw, rng.pMin, rng.pMax)

				if haveLastNorm {
					dx := x - lastNormX
					dy := y - lastNormY
					if (dx*dx + dy*dy) < 1e-8 {
						return
					}
				}
				lastNormX, lastNormY, haveLastNorm = x, y, true

				batch = append(batch, []float64{x, y, p, float64(nowMS())})
				_ = sendPts(false)
			}
		}
	}

	debugTick := time.Now()
	flushTick := time.NewTicker(flushEvery)
	defer flushTick.Stop()

	for {
		select {
		case err := <-ws.Err():
			// ping/pong/close/write failure: bail so the outer loop reconnects
			return err
		case ev := <-evC:
			handle(ev.etype, ev.code, ev.value)
		case <-flushTick.C:
		}

		// Flush on timer even if SYN_REPORT is sparse.
		if strokeID != "" && len(batch) > 0 && time.Since(lastFlush) >= flushEvery {
			if err := sendPts(true); err != nil {
				return err
			}
		}

		if cfg.Debug && time.Since(debugTick) > 2*time.Second {
			debugTick = time.Now()
			fmt.Printf("[bridge] stats touching=%v strokes=%d brush=%s\n", touching, strokesSent.Load(), curBrush)
		}

		// If input goes quiet, print a hint in debug mode.
		if cfg.Debug && time.Since(lastAnyEvent) > 5*time.Second {
			fmt.Printf("[bridge] note: no pen events for 5s (fine if idle; else try -list-devices or -input /dev/input/eventX)\n")
			lastAnyEvent = time.Now()
		}
	}
}
