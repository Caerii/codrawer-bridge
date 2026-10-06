package main

// The bridge's end of the codrawer-layer extension's socket (/run/codrawer/ink.sock).
//
// Two things travel over it (bridge/remarkable/xovi/codrawer-layer/main.cpp, "The agent ink
// socket" and "Actions"):
//
//   - bridge → extension: agent ink. With NATIVE_AGENT_INK=1 the router's ai-layer strokes are
//     followed by package agentink and each finished stroke becomes one line, which the
//     extension commits into the "codrawer: agent" layer of the page on screen through xochitl's
//     own pen-commit path. The extension answers `ok <id> <n>` or `err <id> <reason>`.
//   - extension → bridge: `dock_action` lines from the buttons it injects into xochitl's UI. The
//     bridge adds the open document's id and sends them to the router like a key, so agents can
//     act on them (docs/protocol.md, "dock_action").
//   - bridge → extension: text. The extension greets with `hello codrawer-layer ink text_insert
//     text_read`; from then on `/term` replies (typer.go's job) go into the focused text box as
//     `{"op":"text_insert","id":"tN","text":…}`, inserted the way an input method commits text,
//     which the uinput keyboard cannot match (it drops the first characters after an Enter and
//     has no ^ [ ] { } \ ` ~). An `err tN …` answer sends that text to the uinput typer instead.
//
// NATIVE_AGENT_INK is off by default (ADR 003: agent ink on the user's own notebook is the
// user's choice). The connection itself is made whenever INK_SOCKET is not "off", so the dock
// works with agent ink off. Without the extension (stock xochitl) the socket does not exist and
// the bridge retries with a backoff up to 30 s, which is the only cost of this file on a stock
// tablet: a failed connect() every 30 s.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codrawer-bridge-native/agentink"
)

// inkLink is what the rest of the bridge sees of the connection: whether text insertion is on
// offer, and a way to ask for it. A nil *inkLink offers nothing.
type inkLink struct {
	textOK   atomic.Bool // the connected extension said text_insert
	textC    chan string
	fallback atomic.Value // func(string): the uinput typer, for refused inserts
	pending  sync.Map     // id → text, until the extension answers
	seq      atomic.Int64
}

// insertText queues s for the focused text box; false when the extension cannot take it now.
func (l *inkLink) insertText(s string) bool {
	if l == nil || !l.textOK.Load() {
		return false
	}
	select {
	case l.textC <- s:
		return true
	default:
		return false
	}
}

func (l *inkLink) setFallback(f func(string)) {
	if l != nil {
		l.fallback.Store(f)
	}
}

// fallBack hands text the extension did not insert to the uinput typer.
func (l *inkLink) fallBack(text string) {
	if f, ok := l.fallback.Load().(func(string)); ok && f != nil {
		f(text)
	}
}

// textOp is the socket line for one insert (encoding/json: the text may hold anything).
func textOp(id, text string) []byte {
	b, _ := json.Marshal(struct {
		Op   string `json:"op"`
		ID   string `json:"id"`
		Text string `json:"text"`
	}{"text_insert", id, text})
	return b
}

// startAgentInk starts the socket loop. It returns the hook for router messages (nil when agent
// ink is off), the channel of dock actions for the router and the link for text insertion (both
// nil when the socket is off).
func startAgentInk(cfg BridgeConfig, pages *pageFeed) (func([]byte), <-chan []byte, *inkLink) {
	path := strings.TrimSpace(cfg.InkSocket)
	if path == "" || strings.EqualFold(path, "off") {
		return nil, nil, nil
	}
	link := &inkLink{textC: make(chan string, 256)}
	actions := make(chan []byte, 64)
	var msgs chan []byte
	var hook func([]byte)
	if cfg.NativeAgentInk {
		msgs = make(chan []byte, 1024)
		hook = func(b []byte) {
			// Only stroke messages on any layer can matter; the forwarder checks the layer.
			if !bytes.Contains(b, []byte(`"stroke_`)) {
				return
			}
			select {
			case msgs <- b:
			default: // the socket is far behind; agent ink is dropped rather than block the reader
			}
		}
	}
	fmt.Printf("[ink] socket %s, native agent ink %v\n", path, cfg.NativeAgentInk)
	go agentInkForever(path, msgs, actions, link, &pageCache{feed: pages}, cfg.Debug)
	return hook, actions, link
}

// pageCache parses the header of the latest `page` snapshot once per snapshot.
type pageCache struct {
	feed *pageFeed
	seq  int
	page agentink.Page
}

func (c *pageCache) get() agentink.Page {
	if c.feed == nil {
		return agentink.Page{}
	}
	b, seq, _ := c.feed.get()
	if seq != c.seq {
		c.seq, c.page = seq, agentink.PageOf(b)
	}
	return c.page
}

// agentInkForever connects, serves one connection until it fails, and reconnects.
func agentInkForever(path string, msgs <-chan []byte, actions chan<- []byte, link *inkLink, pages *pageCache, debug bool) {
	fwd := &agentink.Forwarder{}
	var mu sync.Mutex // pages is read by the reader goroutine (actions) and this one (ink)
	page := func() agentink.Page { mu.Lock(); defer mu.Unlock(); return pages.get() }
	backoff := time.Second
	logged := false
	for {
		conn, err := net.Dial("unix", path)
		if err != nil {
			if !logged || debug {
				fmt.Printf("[ink] %s not available (%v); retrying up to every 30 s\n", path, err)
				logged = true
			}
			time.Sleep(backoff)
			backoff = min(backoff*2, 30*time.Second)
			continue
		}
		fmt.Printf("[ink] connected to %s\n", path)
		backoff, logged = time.Second, false
		done := make(chan struct{})
		go readInkReplies(conn, actions, link, page, debug, done)
		serveInk(conn, msgs, link, fwd, page, done)
		conn.Close()
		<-done
		link.textOK.Store(false)
		link.pending.Range(func(k, v any) bool { // asked but never answered: type them
			link.pending.Delete(k)
			link.fallBack(v.(string))
			return true
		})
		fmt.Printf("[ink] disconnected (sent %d, dropped rate %d size %d no-page %d)\n",
			fwd.Sent, fwd.DroppedRate, fwd.DroppedSize, fwd.DroppedNoPage)
	}
}

// serveInk forwards finished ai strokes until the connection fails or the reader ends.
func serveInk(conn net.Conn, msgs <-chan []byte, link *inkLink, fwd *agentink.Forwarder, page func() agentink.Page, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case text := <-link.textC:
			id := fmt.Sprintf("t%d", link.seq.Add(1))
			link.pending.Store(id, text)
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := conn.Write(append(textOp(id, text), '\n')); err != nil {
				fmt.Printf("[ink] write: %v\n", err)
				return // the pending text is typed after the reader ends
			}
		case m := <-msgs: // nil channel (agent ink off): never ready
			line, why := fwd.Handle(m, page())
			if why != "" {
				fmt.Printf("[ink] not sent: %s\n", why)
			}
			if line == nil {
				continue
			}
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := conn.Write(append(line, '\n')); err != nil {
				fmt.Printf("[ink] write: %v\n", err)
				return
			}
		}
	}
}

// readInkReplies reads the extension's lines: replies are logged (errors always, ok with
// debug), actions go to the router. It closes done when the connection ends.
func readInkReplies(conn net.Conn, actions chan<- []byte, link *inkLink, page func() agentink.Page, debug bool, done chan<- struct{}) {
	defer close(done)
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 0, 4096), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		fields := strings.Fields(string(line))
		switch {
		case len(fields) > 0 && fields[0] == "hello":
			on := strings.Contains(string(line), " text_insert")
			link.textOK.Store(on)
			fmt.Printf("[ink] extension: %s (text insertion %v)\n", line, on)
		case len(fields) > 1 && (fields[0] == "ok" || fields[0] == "err" || fields[0] == "text") && strings.HasPrefix(fields[1], "t"):
			if v, ok := link.pending.LoadAndDelete(fields[1]); ok && fields[0] == "err" {
				fmt.Printf("[ink] text insert refused (%s); typing it instead\n", line)
				link.fallBack(v.(string))
			} else if debug || fields[0] == "text" {
				fmt.Printf("[ink] extension: %s\n", line)
			}
		case len(line) > 0 && line[0] == '{':
			out := agentink.DockAction(line, page())
			if out == nil {
				fmt.Printf("[ink] refused action %q\n", line)
				continue
			}
			fmt.Printf("[ink] action %s\n", out)
			select {
			case actions <- out:
			default:
				fmt.Printf("[ink] action dropped: router link backed up\n")
			}
		case bytes.HasPrefix(line, []byte("err")):
			fmt.Printf("[ink] extension: %s\n", line)
		default:
			if debug {
				fmt.Printf("[ink] extension: %s\n", line)
			}
		}
	}
}
