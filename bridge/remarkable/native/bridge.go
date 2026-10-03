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
//   - RunBridgeForever dials the router and drains the outbox, keyC and the page feed into the
//     socket until it dies, then reconnects with backoff. It also notices a suspend/resume and
//     reconnects at once instead of writing into a socket that died while the tablet slept.
//
// The socket is the only thing that comes and goes. Each connection gets its own pumps (keys,
// pages) next to the outbox writer; WSConn serialises their writes.

import (
	"context"
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
	onMessage := startTyper(cfg)

	connectForever(cfg, outC, keyC, pages, onMessage)
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
// the returned channel regardless of socket state; a connection's pump drains it while up.
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
// messages from the router (nil when off: the bridge then ignores what the router sends).
func startTyper(cfg BridgeConfig) func([]byte) {
	if !cfg.TypeReplies {
		return func([]byte) {}
	}
	typeC := make(chan string, 1024)
	go typerForever(typeC, time.Duration(max(1, cfg.TypeCharMs))*time.Millisecond, cfg.Debug)
	return func(data []byte) {
		out, ok := typedReply(data)
		if !ok {
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
func connectForever(cfg BridgeConfig, outC <-chan []byte, keyC chan outKey, pages *pageFeed, onMessage func([]byte)) {
	pingEvery := time.Duration(float64(time.Second) * math.Max(1, cfg.PingSeconds))
	pongWait := time.Duration(float64(time.Second) * math.Max(2, cfg.PongTimeoutSeconds))
	wsURL := sourceURL(cfg.WsURL)

	reconnectDelay := reconnectMin
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
		err = runConnection(ws, outC, keyC, pages)
		fmt.Printf("[bridge] disconnected; reconnecting in %s (err=%v)\n", reconnectDelay, err)
		time.Sleep(reconnectDelay)
	}
}

// runConnection starts this connection's pumps, writes the outbox until the socket fails, then
// stops the pumps and closes the socket.
func runConnection(ws *WSConn, outC <-chan []byte, keyC chan outKey, pages *pageFeed) error {
	stopPump := make(chan struct{})
	if keyC != nil {
		go pumpKeys(ws, keyC, stopPump)
	}
	if pages != nil {
		go pumpPages(ws, pages, stopPump)
	}
	err := writeOutbox(ws, outC)
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

// writeOutbox writes queued messages until the socket fails. A wall clock that jumps ahead of
// the monotonic clock means the tablet was suspended (the monotonic clock stops in suspend): the
// socket is presumed dead, since its timers did not run while asleep, and the caller reconnects
// immediately.
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

// pumpKeys forwards keyboard messages over the current socket until stop closes. A write failure
// is reported to the socket's error channel so the outbox writer reconnects.
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
