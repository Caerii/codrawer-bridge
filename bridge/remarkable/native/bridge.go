package main

// Wiring and the connection loop.
//
// Data flows one way through each stage, with no shared mutable state between them:
//
//   - penReaderForever (pen_stream.go) owns the pen device for the life of the process and
//     parses input_events, with kernel timestamps, into evC; it reopens the device on error and
//     resynchronises after a kernel SYN_DROPPED.
//   - penMachineForever (pen_stream.go) runs one pen.Machine for the life of the process. It
//     always drains evC, so contact state is never lost while the network is down, and turns
//     events into encoded messages on the outbox. A full outbox skips whole strokes.
//   - runKeyboardForever (keyboard.go) produces `key` messages on keyC.
//   - runPageWatch (page_watch.go) keeps the latest `page` snapshot in a pageFeed.
//   - typerForever (typer.go) types `term` replies that arrive from the router.
//   - agentInkForever (agent_ink.go) hands the router's ai-layer strokes to the codrawer-layer
//     extension inside xochitl (NATIVE_AGENT_INK) and brings its `dock_action`s back.
//   - RunBridgeForever dials the router and drains the outbox, keyC and the page feed into the
//     socket until it dies, then reconnects with backoff. It also notices a suspend/resume and
//     reconnects at once instead of writing into a socket that died while the tablet slept.
//
// The socket is the only thing that comes and goes. Each connection gets a page pump next to
// the outbox writer (which also writes keys); WSConn serialises their writes.
//
// Nothing here wakes on a timer while the tablet is idle: the batch timer is armed only while
// points wait, the suspend check runs at each write rather than every second (suspendCheck), and
// the only periodic work left on a connection is its keepalive ping (-ping-seconds, 10 s).
// docs/investigations/idle-cost.md has the measurements.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"net/url"
	"os"
	"strings"
	"time"

	"codrawer-bridge-native/pen"
)

// outboxSize bounds what is held while the link is down: about 30 s of continuous drawing
// at 60 batches/s. Older ink is delivered first when the link returns.
const outboxSize = 2048

// Reconnect backoff: from reconnectMin, ×1.7 per failed dial up to reconnectMax, plus up to
// reconnectJitter so that several devices do not retry in lockstep.
const (
	reconnectMin    = 500 * time.Millisecond
	reconnectMax    = 5 * time.Second
	reconnectJitter = 250 * time.Millisecond
)

// RunBridgeForever starts every source and then streams into the router until the process
// exits. It returns only on a startup error (no pen device), or nil after -list-devices.
func RunBridgeForever(cfg BridgeConfig) error {
	if cfg.ListDevices {
		for _, d := range listProcInputDevices() {
			fmt.Printf("name=%q handlers=%v\n", d.name, d.handlers)
		}
		return nil
	}

	outC, err := startPen(cfg)
	if err != nil {
		return err
	}
	keyC := startKeyboard(cfg)
	pages := startPageWatch(cfg)
	inkHook, actions, ink := startAgentInk(cfg, pages)
	typed := startTyper(cfg, ink)
	onMessage := typed
	if inkHook != nil {
		onMessage = func(b []byte) { typed(b); inkHook(b) }
	}

	connectForever(cfg, outC, keyC, actions, pages, onMessage)
	return nil
}

// startPen finds the pen device, starts its reader and machine, and returns the outbox.
func startPen(cfg BridgeConfig) (<-chan []byte, error) {
	probeDur := time.Duration(float64(time.Second) * math.Max(0.1, cfg.ProbeSeconds))
	path, err := autoDetectActiveDevice(cfg.InputDevice, cfg.Debug, probeDur)
	if err != nil {
		return nil, err
	}
	fmt.Printf("[bridge] using input device: %s\n", path)

	evC := make(chan pen.Event, 4096)
	readyC := make(chan pen.Ranges, 1)
	go penReaderForever(path, cfg, evC, readyC)
	rng := <-readyC // the machine needs the axis ranges, known once the device opened

	outC := make(chan []byte, outboxSize)
	go penMachineForever(cfg, rng, evC, outC)
	return outC, nil
}

// startKeyboard starts the keyboard reader unless KEYBOARD_DEVICE=off. Key events flow through
// the returned channel regardless of socket state; the outbox writer drains it while up.
func startKeyboard(cfg BridgeConfig) chan outKey {
	if strings.ToLower(strings.TrimSpace(cfg.Keyboard)) == "off" {
		return nil
	}
	keyC := make(chan outKey, 256)
	go runKeyboardForever(cfg.Keyboard, cfg.KeyboardGrab, cfg.Debug, keyC)
	return keyC
}

// startPageWatch starts the page watcher when enabled (page_watch.go) and returns its feed, or
// nil after logging why it is off.
func startPageWatch(cfg BridgeConfig) *pageFeed {
	if !pageWatchEnabled(cfg.PageWatch, os.Getenv("CODRAWER_OS_TESTED")) {
		fmt.Printf("[page] watcher off (PAGE_WATCH=%s, CODRAWER_OS_TESTED=%q)\n", cfg.PageWatch, os.Getenv("CODRAWER_OS_TESTED"))
		return nil
	}
	pages := newPageFeed()
	go runPageWatch(cfg.XochitlDir, time.Duration(max(100, cfg.PagePollMs))*time.Millisecond, pages, cfg.Debug)
	return pages
}

// startTyper starts the virtual keyboard when TYPE_REPLIES is on and returns the handler for
// messages from the router (nil when off: the bridge then ignores what the router sends). When
// the codrawer-layer extension is connected and offers text_insert, a reply goes into the
// focused text box through it instead (agent_ink.go, "Text"); the virtual keyboard stays the
// fallback, also for any insert the extension refuses.
func startTyper(cfg BridgeConfig, ink *inkLink) func([]byte) {
	if !cfg.TypeReplies {
		return func([]byte) {}
	}
	typeC := make(chan string, 1024)
	go typerForever(typeC, time.Duration(max(1, cfg.TypeCharMs))*time.Millisecond, cfg.Debug)
	typeKeys := func(out string) {
		select {
		case typeC <- out:
		default: // the typer is far behind; drop rather than block
		}
	}
	ink.setFallback(typeKeys)
	return func(data []byte) {
		out, ok := typedReply(data)
		if !ok {
			return
		}
		if ink.insertText(out) {
			return
		}
		select {
		case typeC <- out:
		default: // the typer is far behind; drop rather than block the socket reader
		}
	}
}

// ── the connection loop ─────────────────────────────────────────────────────

// connectForever dials the router, runs one connection until it fails, and reconnects.
func connectForever(cfg BridgeConfig, outC <-chan []byte, keyC chan outKey, actions <-chan []byte, pages *pageFeed, onMessage func([]byte)) {
	pingEvery := time.Duration(float64(time.Second) * math.Max(1, cfg.PingSeconds))
	pongWait := time.Duration(float64(time.Second) * math.Max(2, cfg.PongTimeoutSeconds))
	wsURL := sourceURL(cfg.WsURL)

	reconnectDelay := reconnectMin
	var held []byte // written first on the next connection (see writeOutbox)
	for {
		ws, err := DialWS(context.Background(), wsURL, pingEvery, pongWait, onMessage)
		if err != nil {
			j := time.Duration(rand.Int63n(int64(reconnectJitter)))
			fmt.Printf("[bridge] ws connect error: %v; retrying in %s\n", err, reconnectDelay+j)
			time.Sleep(reconnectDelay + j)
			reconnectDelay = time.Duration(math.Min(float64(reconnectMax), float64(reconnectDelay)*1.7))
			continue
		}

		fmt.Printf("[bridge] connected ws=%s\n", wsURL)
		reconnectDelay = reconnectMin
		err = runConnection(ws, outC, keyC, actions, pages, &held)
		fmt.Printf("[bridge] disconnected; reconnecting in %s (err=%v)\n", reconnectDelay, err)
		time.Sleep(reconnectDelay)
	}
}

// runConnection starts this connection's page pump, writes the outbox and keys until the socket
// fails, then stops the pump and closes the socket.
func runConnection(ws *WSConn, outC <-chan []byte, keyC chan outKey, actions <-chan []byte, pages *pageFeed, held *[]byte) error {
	stopPump := make(chan struct{})
	if pages != nil {
		go pumpPages(ws, pages, stopPump)
	}
	err := writeOutbox(ws, outC, keyC, actions, held)
	close(stopPump)
	ws.Close()
	return err
}

// sourceURL marks the bridge as a pen source: a replaying router (the Go one) then skips the
// page replay, which the bridge has no use for. Routers that do not replay ignore it. An
// explicit replay= in the URL is kept.
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

// writeOutbox writes queued messages and keys until the socket fails. A tablet that was
// suspended (suspendCheck, run by every WSConn write) has its socket presumed dead, since its
// timers did not run while asleep: the message is kept in *held for the next connection and
// the caller reconnects immediately. A nil keyC or actions channel is never ready. Actions are
// the codrawer-layer extension's `dock_action` messages (agent_ink.go), sent as they are.
func writeOutbox(ws *WSConn, outC <-chan []byte, keyC <-chan outKey, actions <-chan []byte, held *[]byte) error {
	write := func(msg []byte) error {
		err := ws.WriteRaw(msg)
		var r *resumedError
		if errors.As(err, &r) {
			*held = msg
		}
		// Otherwise a failed message is lost with the socket; the router ends the stroke.
		return err
	}
	if msg := *held; msg != nil {
		*held = nil
		if err := write(msg); err != nil {
			return err
		}
	}
	for {
		select {
		case err := <-ws.Err():
			return err
		case msg := <-outC:
			if err := write(msg); err != nil {
				return err
			}
		case a := <-actions:
			if err := write(a); err != nil {
				return err
			}
		case k := <-keyC:
			b, err := json.Marshal(k)
			if err != nil {
				return err
			}
			if err := write(b); err != nil {
				return err
			}
		}
	}
}

// resumedError: the tablet slept since the last write on this socket.
type resumedError struct{ gap time.Duration }

func (e *resumedError) Error() string {
	return fmt.Sprintf("resumed after ~%s asleep", e.gap.Round(time.Second))
}

// suspendCheck notices that the tablet slept: the wall clock ran more than 2 s ahead of the
// monotonic clock (which stops in suspend) since the last look. Looking costs two clock reads,
// so it is done at each write instead of on a ticker: an idle bridge does not wake to check,
// and a write is exactly when a socket that died in suspend would swallow ink.
type suspendCheck struct {
	wall, mono time.Time
}

func newSuspendCheck(now time.Time) suspendCheck { return suspendCheck{wall: now.Round(0), mono: now} }

// resumed is resumedAt with both readings of now (time.Now carries a monotonic one).
func (c *suspendCheck) resumed(now time.Time) error { return c.resumedAt(now.Round(0), now) }

// resumedAt reports a suspend since the last call: wall is a wall-clock reading, mono one whose
// differences are monotonic. A wall clock stepped back is no suspend.
func (c *suspendCheck) resumedAt(wall, mono time.Time) error {
	gap := wall.Sub(c.wall) - mono.Sub(c.mono)
	c.wall, c.mono = wall, mono
	if gap > 2*time.Second {
		return &resumedError{gap: gap}
	}
	return nil
}
