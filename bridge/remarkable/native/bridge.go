package main

// Bridge run loop + stroke state machine.
//
// This file is intentionally verbose and heavily commented because it is the "business logic"
// for turning Linux input events into protocol messages.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
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

	Debug      bool
	DumpEvents bool
	ListDevices bool

	ProbeSeconds       float64
	PingSeconds        float64
	PongTimeoutSeconds float64
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

	flushEvery := time.Second / time.Duration(max(1, cfg.BatchHz))
	pingEvery := time.Duration(float64(time.Second) * math.Max(1, cfg.PingSeconds))
	pongWait := time.Duration(float64(time.Second) * math.Max(2, cfg.PongTimeoutSeconds))

	reconnectDelay := 500 * time.Millisecond
	maxReconnectDelay := 5 * time.Second

	var strokesSent atomic.Int64

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

		err = runOnce(path, cfg, ws, flushEvery, &strokesSent)
		ws.Close()
		fmt.Printf("[bridge] disconnected; strokes_sent=%d; reconnecting in %s (err=%v)\n", strokesSent.Load(), reconnectDelay, err)
		time.Sleep(reconnectDelay)
	}
}

func runOnce(path string, cfg BridgeConfig, ws *WSConn, flushEvery time.Duration, strokesSent *atomic.Int64) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	fd := int(f.Fd())
	if !cfg.NoGrab {
		tryGrab(fd)
	}

	rng := getRanges(fd)
	reader := bufio.NewReaderSize(f, 4096)
	parser := &inputParser{}

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
		touching    bool
		strokeID    string
		batch       [][]float64
		lastFlush   = time.Now()
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

	debugTick := time.Now()

	for {
		// If WS layer reports an error (ping/pong/close), bail so outer loop reconnects.
		select {
		case err := <-ws.Err():
			return err
		default:
		}

		chunk := make([]byte, 4096)
		n, err := reader.Read(chunk)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return err
			}
			return err
		}

		parser.feed(chunk[:n], func(etype uint16, code uint16, value int32) {
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
		})

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
			fmt.Printf("[bridge] warning: no input events seen for 5s on %s (try -list-devices, increase -probe-seconds, or pass -input /dev/input/eventX)\n", path)
			lastAnyEvent = time.Now()
		}
	}
}


