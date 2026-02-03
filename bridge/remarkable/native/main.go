package main

// Native Paper Pro bridge entrypoint.
//
// This directory builds a single self-contained binary that:
// - reads /dev/input/event* (Linux input)
// - detects pen contact + tool mode (pen vs eraser)
// - streams stroke messages to the desktop server over WebSocket
//
// Code is split across:
// - util.go: env/flag helpers
// - linux_input.go: Linux input constants + ioctl + input_event parsing
// - device_select.go: device listing + probing/selection
// - ws_client.go: robust websocket client (ping/pong, TCP keepalive, reconnect signals)
// - bridge.go: stroke state machine + main run loop

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	cfg := BridgeConfig{
		WsURL:              getenvDefault("DESKTOP_WS", "ws://127.0.0.1:8000/ws/session1"),
		Brush:              getenvDefault("BRUSH", "pen"),
		Color:              os.Getenv("COLOR"),
		InputDevice:        os.Getenv("INPUT_DEVICE"),
		BatchHz:            getenvIntDefault("BATCH_HZ", 60),
		MaxBatchPoints:     getenvIntDefault("MAX_BATCH_POINTS", 64),
		NoGrab:             getenvBoolDefault("NO_GRAB", true),
		TouchMode:          getenvDefault("TOUCH_MODE", "auto"),
		PressureThreshold:  getenvFloatDefault("PRESSURE_THRESHOLD", 0.02),
		DistanceThreshold:  getenvIntDefault("DISTANCE_THRESHOLD", 0),
		Debug:              getenvBoolDefault("DEBUG", false),
		DumpEvents:         getenvBoolDefault("DUMP_EVENTS", false),
		ListDevices:        false,
		ProbeSeconds:       getenvFloatDefault("PROBE_SECONDS", 1.5),
		PingSeconds:        getenvFloatDefault("PING_SECONDS", 2),
		PongTimeoutSeconds: getenvFloatDefault("PONG_TIMEOUT_SECONDS", 8),
	}

	flag.StringVar(&cfg.WsURL, "ws", cfg.WsURL, "WebSocket URL to desktop server")
	flag.StringVar(&cfg.Brush, "brush", cfg.Brush, "Brush name for pen strokes (non-eraser)")
	flag.StringVar(&cfg.Color, "color", cfg.Color, "Optional color hint (e.g. #00ff88). Not available from raw input; set via config.")
	flag.StringVar(&cfg.InputDevice, "input", cfg.InputDevice, "Input device path (e.g. /dev/input/event3). If empty, auto-detect.")
	flag.IntVar(&cfg.BatchHz, "batch-hz", cfg.BatchHz, "Batch flush rate (Hz)")
	flag.IntVar(&cfg.MaxBatchPoints, "max-batch", cfg.MaxBatchPoints, "Max points per batch")
	flag.BoolVar(&cfg.NoGrab, "no-grab", cfg.NoGrab, "Do not EVIOCGRAB the input device (recommended)")
	flag.StringVar(&cfg.TouchMode, "touch-mode", cfg.TouchMode, "How to detect contact: auto|btn|pressure|distance|tool")
	flag.Float64Var(&cfg.PressureThreshold, "pressure-threshold", cfg.PressureThreshold, "Contact threshold for pressure mode (0..1)")
	flag.IntVar(&cfg.DistanceThreshold, "distance-threshold", cfg.DistanceThreshold, "Contact threshold for distance mode (down if ABS_DISTANCE <= threshold)")
	flag.BoolVar(&cfg.Debug, "debug", cfg.Debug, "Print contact transitions + periodic stats")
	flag.BoolVar(&cfg.DumpEvents, "dump-events", cfg.DumpEvents, "Print raw input events (type/code/value). Noisy.")
	flag.BoolVar(&cfg.ListDevices, "list-devices", false, "Print /proc/bus/input/devices names/handlers and exit")
	flag.Float64Var(&cfg.ProbeSeconds, "probe-seconds", cfg.ProbeSeconds, "Seconds to probe each /dev/input/event* for activity when auto-detecting (draw during this!)")
	flag.Float64Var(&cfg.PingSeconds, "ping-seconds", cfg.PingSeconds, "WebSocket ping interval (seconds). Aggressive keepalive.")
	flag.Float64Var(&cfg.PongTimeoutSeconds, "pong-timeout-seconds", cfg.PongTimeoutSeconds, "Reconnect if no pong is received in this window.")
	flag.Parse()

	if err := RunBridgeForever(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "fatal: %v\n", err)
		os.Exit(1)
	}
}
