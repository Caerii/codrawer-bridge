package main

// WebSocket client with:
// - TCP keepalive on the dialer
// - aggressive ping ticker
// - pong watchdog (read deadline)
// - background reader to process control frames (required!)
//
// The bridge doesn't need to consume server messages; it only needs
// to keep the connection healthy and write stroke messages.

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type WSConn struct {
	Conn *websocket.Conn
	mu   sync.Mutex

	done chan struct{}
	errC chan error
}

func DialWS(ctx context.Context, wsURL string, pingEvery time.Duration, pongWait time.Duration) (*WSConn, error) {
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
		Conn: conn,
		done: make(chan struct{}),
		errC: make(chan error, 1),
	}

	// Keepalive needs READ to process PONG/close frames.
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

func (w *WSConn) Close() {
	select {
	case <-w.done:
		// already closed
	default:
		close(w.done)
	}
	_ = w.Conn.Close()
}

func (w *WSConn) Err() <-chan error { return w.errC }

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
		_, _, err := w.Conn.ReadMessage()
		if err != nil {
			w.sendErr(err)
			return
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

func (w *WSConn) WriteJSON(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.Conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return w.Conn.WriteMessage(websocket.TextMessage, b)
}


