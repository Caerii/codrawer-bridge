package main

// Configuration: every setting is an environment variable (the systemd unit reads them from
// /home/root/codrawer/bridge.env and /run/codrawer/env) with a command-line flag of the same
// meaning that overrides it. The defaults below are the shipped behaviour; README.md lists them.

import (
	"flag"
	"fmt"
	"math"
	"os"
	"strings"

	"codrawer-bridge-native/pagewatch"
	"codrawer-bridge-native/toolhint"
)

// BridgeConfig is the bridge's whole configuration. Field comments give the env var and the
// unit; the flag name is in loadConfig.
type BridgeConfig struct {
	WsURL          string // DESKTOP_WS: the router session to stream into, ws://host:port/ws/<session>
	Brush          string // BRUSH: brush hint for pen strokes; the eraser end is always "eraser"
	Color          string // COLOR: optional colour hint (#rrggbb); raw input carries no colour
	InputDevice    string // INPUT_DEVICE: the pen's /dev/input/eventN ("" = probe; on the Paper Pro set event2)
	BatchHz        int    // BATCH_HZ: stroke_pts batches per second while drawing
	MaxBatchPoints int    // MAX_BATCH_POINTS: flush a batch early at this many points
	NoGrab         bool   // NO_GRAB: do not EVIOCGRAB the pen, so xochitl keeps drawing locally

	TouchMode         string  // TOUCH_MODE: auto|btn|pressure|distance|tool (package pen)
	HoverHz           int     // HOVER_HZ: cursor messages per second while hovering (0: off)
	PressureThreshold float64 // PRESSURE_THRESHOLD: pressure mode contact threshold, 0..1
	DistanceThreshold int     // DISTANCE_THRESHOLD: distance mode: down if ABS_DISTANCE <= this

	Debug       bool // DEBUG: probe scores, periodic pen stats, keys, typed text, every page error
	DumpEvents  bool // DUMP_EVENTS: print every raw input event (very noisy)
	ListDevices bool // -list-devices only: print the input devices and exit

	ProbeSeconds       float64 // PROBE_SECONDS: probe window per device when auto-detecting
	PingSeconds        float64 // PING_SECONDS: WebSocket ping interval to the router
	PongTimeoutSeconds float64 // PONG_TIMEOUT_SECONDS: reconnect if no pong within this

	// Keyboard (KEYBOARD_DEVICE): "auto" (find a kbd device), "off", or an explicit
	// /dev/input/eventN. KeyboardGrab (KEYBOARD_GRAB) makes the bridge its only reader.
	Keyboard     string
	KeyboardGrab bool

	// TypeReplies (TYPE_REPLIES): type terminal (`term`) replies into the tablet's focused text
	// field through a virtual keyboard (uinput). TypeCharMs (TYPE_CHAR_MS) paces the keystrokes.
	TypeReplies bool
	TypeCharMs  int

	// ServeAddr (SERVE_ADDR) runs the stroke router (package router) in this process, so the
	// glasses app can connect to the tablet directly. RouterOnly (ROUTER_ONLY) skips the pen
	// and keyboard.
	ServeAddr  string
	RouterOnly bool

	// PageWatch (PAGE_WATCH, page_watch.go): auto | on | off. XochitlDir (XOCHITL_DIR) is
	// xochitl's data directory, PagePollMs (PAGE_POLL_MS) how often it is checked.
	PageWatch  string
	XochitlDir string
	PagePollMs int

	// ToolFile (TOOL_FILE, package toolhint): where the codrawer-layer XOVI extension reports
	// xochitl's selected tool, so that the toolbar Eraser used with the tip streams as an
	// eraser. "off" disables it; an absent or stale file changes nothing.
	ToolFile string
}

// loadConfig reads the environment, then the flags. pageDump reports -page-dump.
func loadConfig() (cfg BridgeConfig, pageDump bool) {
	cfg = BridgeConfig{
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
		Keyboard:           getenvDefault("KEYBOARD_DEVICE", "auto"),
		KeyboardGrab:       getenvBoolDefault("KEYBOARD_GRAB", false),
		TypeReplies:        getenvBoolDefault("TYPE_REPLIES", true),
		TypeCharMs:         getenvIntDefault("TYPE_CHAR_MS", 12),
		HoverHz:            getenvIntDefault("HOVER_HZ", 30),
		ServeAddr:          os.Getenv("SERVE_ADDR"),
		RouterOnly:         getenvBoolDefault("ROUTER_ONLY", false),
		PageWatch:          getenvDefault("PAGE_WATCH", "auto"),
		XochitlDir:         getenvDefault("XOCHITL_DIR", pagewatch.DefaultDir),
		PagePollMs:         getenvIntDefault("PAGE_POLL_MS", 1000),
		ToolFile:           getenvDefault("TOOL_FILE", toolhint.DefaultPath),
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
	flag.StringVar(&cfg.Keyboard, "keyboard", cfg.Keyboard, "Keyboard device: auto (find a kbd device), off, or /dev/input/eventN. Emits key messages.")
	flag.BoolVar(&cfg.KeyboardGrab, "keyboard-grab", cfg.KeyboardGrab, "EVIOCGRAB the keyboard so only the bridge receives it (default: the tablet UI keeps it too)")
	flag.BoolVar(&cfg.TypeReplies, "type-replies", cfg.TypeReplies, "Type terminal replies into the tablet's focused text field via a virtual keyboard (uinput)")
	flag.IntVar(&cfg.TypeCharMs, "type-char-ms", cfg.TypeCharMs, "Milliseconds between typed characters")
	flag.IntVar(&cfg.HoverHz, "hover-hz", cfg.HoverHz, "Pen hover position (cursor messages) per second, for a pointer on viewers; 0 disables")
	flag.StringVar(&cfg.ServeAddr, "serve", cfg.ServeAddr, "Also run the stroke router on this address (e.g. :8577); point -ws at ws://127.0.0.1:<port>/ws/<session>")
	flag.BoolVar(&cfg.RouterOnly, "router-only", cfg.RouterOnly, "Run only the router (-serve), no pen or keyboard (e.g. on a desktop)")
	flag.StringVar(&cfg.PageWatch, "page-watch", cfg.PageWatch, "Send xochitl's saved page as `page` snapshots: auto (only on an OS boot.sh lists as tested), on, off")
	flag.StringVar(&cfg.XochitlDir, "xochitl-dir", cfg.XochitlDir, "xochitl's data directory (read-only)")
	flag.IntVar(&cfg.PagePollMs, "page-poll-ms", cfg.PagePollMs, "How often the page watcher checks xochitl's files (ms)")
	flag.StringVar(&cfg.ToolFile, "tool-file", cfg.ToolFile, "xochitl's selected tool, written by the codrawer-layer XOVI extension (toolbar Eraser → eraser strokes); off disables")
	flag.BoolVar(&pageDump, "page-dump", false, "Print the `page` message for the open document and page, then exit (read-only)")
	flag.Parse()
	return cfg, pageDump
}

// ── environment helpers ─────────────────────────────────────────────────────
//
// An unset, empty or unparsable variable yields the default, so a typo in bridge.env degrades to
// the shipped behaviour instead of stopping the service.

func getenvDefault(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func getenvIntDefault(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	var out int
	_, err := fmt.Sscanf(v, "%d", &out)
	if err != nil {
		return def
	}
	return out
}

func getenvFloatDefault(k string, def float64) float64 {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	var out float64
	_, err := fmt.Sscanf(v, "%f", &out)
	if err != nil {
		return def
	}
	if math.IsNaN(out) || math.IsInf(out, 0) {
		return def
	}
	return out
}

// getenvBoolDefault accepts 1/true/yes/y and 0/false/no/n, in any case.
func getenvBoolDefault(k string, def bool) bool {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	v = strings.ToLower(strings.TrimSpace(v))
	if v == "1" || v == "true" || v == "yes" || v == "y" {
		return true
	}
	if v == "0" || v == "false" || v == "no" || v == "n" {
		return false
	}
	return def
}
