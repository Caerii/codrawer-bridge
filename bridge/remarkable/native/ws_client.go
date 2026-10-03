package main

// The WebSocket client to the router.
//
// The tablet's link is the least reliable part of the system: Wi-Fi drops when the tablet
// sleeps, and a half-open TCP connection can look healthy for minutes. So the client keeps the
// connection under constant watch: TCP keepalive on the dialer, a ping every -ping-seconds (2 s),
// and a read deadline that only a pong extends, so a silent router is detected
// within -pong-timeout-seconds (8 s). Any failure is reported once on Err(), which the outbox
// writer selects on; the bridge must notice socket errors even while the pen is idle, not only
// after the next pen read (CLAUDE.md, "Facts that cost hours").
//
// A background reader is required even though the bridge mostly writes: gorilla/websocket
// processes pong and close frames only inside a read. The same reader hands text frames to
// OnMessage (the typer, typer.go).

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// WSConn is one connection to the router. Writes are serialised by mu, so the outbox writer and
// the per-connection pumps can share it.
type WSConn struct {
	Conn *websocket.Conn
	mu   sync.Mutex

	done chan struct{}
	errC chan error // capacity 1: the first failure wins

	// OnMessage, when set, receives every text frame from the server. The
	// bridge uses it for `term` replies it types into the tablet.
	OnMessage func(data []byte)
}

// DialWS connects and starts the keepalive. onMessage (may be nil) is installed before the
// reader starts, so no early server message is missed.
func DialWS(ctx context.Context, wsURL string, pingEvery time.Duration, pongWait time.Duration, onMessage func(data []byte)) (*WSConn, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, err
	}

	d := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		NetDialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 15 * time.Second,
		}).DialContext,
	}

	conn, _, err := d.DialContext(ctx, u.String(), nil)
	if err != nil {
		return nil, err
	}

	w := &WSConn{
		Conn:      conn,
		done:      make(chan struct{}),
		errC:      make(chan error, 1),
		OnMessage: onMessage,
	}

	conn.SetReadLimit(1 << 20)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(_ string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	go w.readLoop()
	go w.pingLoop(pingEvery)
	return w, nil
}

// Close stops the reader and pinger and closes the socket; it is safe to call twice.
func (w *WSConn) Close() {
	select {
	case <-w.done:
		// already closed
	default:
		close(w.done)
	}
	_ = w.Conn.Close()
}

// Err delivers the connection's first failure (read, ping or a pump's write).
func (w *WSConn) Err() <-chan error { return w.errC }

// sendErr reports a failure without blocking; later ones are dropped.
func (w *WSConn) sendErr(err error) {
	select {
	case w.errC <- err:
	default:
	}
}

func (w *WSConn) readLoop() {
	for {
		select {
		case <-w.done:
			return
		default:
		}
		mt, data, err := w.Conn.ReadMessage()
		if err != nil {
			w.sendErr(err)
			return
		}
		if mt == websocket.TextMessage && w.OnMessage != nil {
			w.OnMessage(data)
		}
	}
}

func (w *WSConn) pingLoop(pingEvery time.Duration) {
	t := time.NewTicker(pingEvery)
	defer t.Stop()
	for {
		select {
		case <-w.done:
			return
		case <-t.C:
			w.mu.Lock()
			w.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			err := w.Conn.WriteMessage(websocket.PingMessage, []byte("ping"))
			w.mu.Unlock()
			if err != nil {
				w.sendErr(err)
				return
			}
		}
	}
}

// WriteJSON marshals v and sends it as one text message.
func (w *WSConn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return w.WriteRaw(b)
}

// WriteRaw sends an already encoded JSON message (5 s write deadline).
func (w *WSConn) WriteRaw(b []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return w.Conn.WriteMessage(websocket.TextMessage, b)
}
