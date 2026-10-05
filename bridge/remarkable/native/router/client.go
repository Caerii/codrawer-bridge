package router

// One client: a bounded queue and the goroutine that writes it.
//
// Nothing in the router ever blocks on a client. queue never waits: a client whose queue is full
// is closed (it reconnects and gets a fresh replay), because one stalled phone must not slow the
// tablet's stream or the other clients. The write loop owns the socket's write side and also
// sends the keepalives.

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// client is one connection.
type client struct {
	conn     *websocket.Conn
	send     chan []byte // sized at join: the replay plus sendQueue
	addr     string
	once     sync.Once  // closes conn exactly once
	mu       sync.Mutex // guards isClosed and the close of send
	isClosed bool
	// replaying/held are guarded by the session's mutex, not c.mu (conn.go)
	replaying bool
	held      [][]byte
}

// queue never blocks: a client whose queue is full is closed (it will reconnect and replay).
func (c *client) queue(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.isClosed {
		return
	}
	select {
	case c.send <- msg:
	default:
		c.isClosed = true
		close(c.send)
	}
}

// close ends the queue (the write loop then exits) and closes the socket.
func (c *client) close() {
	c.mu.Lock()
	if !c.isClosed {
		c.isClosed = true
		close(c.send)
	}
	c.mu.Unlock()
	c.once.Do(func() { _ = c.conn.Close() })
}

// writeLoop writes queued messages and keepalives until the queue closes or a write fails. A
// queue closed for falling behind gets close code 1013 (try again later, "behind"). On exit it
// closes the socket, which unblocks the read loop.
func (c *client) writeLoop() {
	ping := time.NewTicker(pingEvery)
	defer func() {
		ping.Stop()
		c.once.Do(func() { _ = c.conn.Close() })
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "behind"))
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ping.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
			// browsers never surface protocol pings; this one lets the app see a live link
			if err := c.conn.WriteMessage(websocket.TextMessage, []byte(`{"t":"ping"}`)); err != nil {
				return
			}
		}
	}
}

// mustJSON marshals values that cannot fail to marshal (maps of strings, fixed structs).
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
