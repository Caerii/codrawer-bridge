package main

// The bridge's end of the codrawer-layer extension's socket (/run/codrawer/ink.sock).
//
// Two things travel over it (bridge/remarkable/xovi/codrawer-layer/src/inksock.h and inject.h,
// "Actions"):
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
//   - bridge → extension: `goto` ("take me there", agentink/goto.go). The router's
//     `{"t":"goto",…}` becomes `{"op":"goto","id":"gN",…}`: it navigates when the user's own tap
//     produced it (`origin:"user"`), and is otherwise shown as an offer in the dock. It is relayed
//     whether or not agent ink is on.
//   - bridge → extension: live agent ink (agentink/live.go). While an ai stroke streams in, its
//     new points go as `{"op":"live",…}` lines for the extension's overlay; at its end the commit
//     line is followed by `{"op":"live_end",…}`. The router's `agent_status` becomes
//     `{"op":"overlay",…}` (the "thinking" animation), also with agent ink off.
//   - bridge → extension: `status <text>`, the line the dock shows under "codrawer status"
//     (engine, agent ink on or off), sent on connect and whenever it changes.
//
// The dock's "Agent ink on/off" (`dock_action` id `agent_ink`) toggles native agent ink at run
// time. The choice is kept in agentInkStateFile, which then overrides NATIVE_AGENT_INK at the
// next start, so the user's last word wins over bridge.env.
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
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"codrawer-bridge-native/agentink"
)

// inkLink is what the rest of the bridge sees of the connection: whether text insertion is on
// offer, and a way to ask for it. A nil *inkLink offers nothing.
type inkLink struct {
	agentOn  atomic.Bool   // forward ai strokes now (NATIVE_AGENT_INK, then the dock's toggle)
	statusC  chan struct{} // nudges the writer to send the status line again
	textOK   atomic.Bool   // the connected extension said text_insert
	textC    chan string
	fallback atomic.Value // func(string): the uinput typer, for refused inserts
	pending  sync.Map     // id → text, until the extension answers
	seq      atomic.Int64
	gotoC    chan []byte // router `goto` and `agent_status` messages, checked in the writer
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

// agentInkStateFile keeps the dock's choice across restarts ("1" or "0"); a var for tests.
var agentInkStateFile = "/home/root/codrawer/state/native_agent_ink"

// engineName is the status line's engine word.
const engineName = "go"

// statusLine is what the dock shows for "codrawer status".
func (l *inkLink) statusLine() []byte {
	on := "off"
	if l.agentOn.Load() {
		on = "on"
	}
	return []byte(fmt.Sprintf("status codrawer %s bridge: connected, agent ink %s", engineName, on))
}

// toggleAgentInk flips native agent ink, keeps the choice, and asks for a new status line.
func (l *inkLink) toggleAgentInk() bool {
	on := !l.agentOn.Load()
	l.agentOn.Store(on)
	v := "0"
	if on {
		v = "1"
	}
	if err := os.WriteFile(agentInkStateFile, []byte(v+"\n"), 0o644); err != nil {
		fmt.Printf("[ink] could not keep the agent ink choice: %v\n", err)
	}
	select {
	case l.statusC <- struct{}{}:
	default:
	}
	return on
}

// initialAgentInk: the dock's last choice if one was kept, else NATIVE_AGENT_INK.
func initialAgentInk(env bool) bool {
	b, err := os.ReadFile(agentInkStateFile)
	if err != nil {
		return env
	}
	return strings.TrimSpace(string(b)) == "1"
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
	link := &inkLink{textC: make(chan string, 256), statusC: make(chan struct{}, 1), gotoC: make(chan []byte, 16)}
	link.agentOn.Store(initialAgentInk(cfg.NativeAgentInk))
	actions := make(chan []byte, 64)
	msgs := make(chan []byte, 1024)
	hook := func(b []byte) {
		if (bytes.Contains(b, []byte(`"goto"`)) || bytes.Contains(b, []byte(`"agent_status"`))) && !bytes.Contains(b, []byte(`"stroke_`)) {
			select {
			case link.gotoC <- b: // navigation and the thinking overlay work with agent ink off
			default:
			}
			return
		}
		// Only stroke messages can matter, and only while agent ink is on; the forwarder checks
		// the layer.
		if !link.agentOn.Load() || !bytes.Contains(b, []byte(`"stroke_`)) {
			return
		}
		select {
		case msgs <- b:
		default: // the socket is far behind; agent ink is dropped rather than block the reader
		}
	}
	fmt.Printf("[ink] socket %s, native agent ink %v\n", path, link.agentOn.Load())
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
	write := func(b []byte) bool {
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Write(append(b, '\n')); err != nil {
			fmt.Printf("[ink] write: %v\n", err)
			return false
		}
		return true
	}
	if !write(link.statusLine()) {
		return
	}
	for {
		select {
		case <-done:
			return
		case <-link.statusC:
			if !write(link.statusLine()) {
				return
			}
		case raw := <-link.gotoC:
			if bytes.Contains(raw, []byte(`"agent_status"`)) {
				line, why := agentink.Overlay(raw)
				if line == nil {
					fmt.Printf("[ink] agent_status refused: %s\n", why)
				} else if !write(line) {
					return
				}
				continue
			}
			line, why := agentink.GotoOp(raw, fmt.Sprintf("g%d", link.seq.Add(1)))
			if line == nil {
				if why != "not a goto" {
					fmt.Printf("[ink] goto refused: %s\n", why)
				}
				continue
			}
			fmt.Printf("[ink] goto %s\n", line)
			if !write(line) {
				return
			}
		case text := <-link.textC:
			id := fmt.Sprintf("t%d", link.seq.Add(1))
			link.pending.Store(id, text)
			_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
			if _, err := conn.Write(append(textOp(id, text), '\n')); err != nil {
				fmt.Printf("[ink] write: %v\n", err)
				return // the pending text is typed after the reader ends
			}
		case m := <-msgs:
			if !link.agentOn.Load() {
				continue // switched off while it waited
			}
			lines, why := fwd.HandleAll(m, page()) // live points, then commit + live_end
			if why != "" {
				fmt.Printf("[ink] not sent: %s\n", why)
			}
			for _, line := range lines {
				if !write(line) {
					return
				}
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
			if bytes.Contains(line, []byte(`"id":"agent_ink"`)) {
				fmt.Printf("[ink] native agent ink now %v (dock)\n", link.toggleAgentInk())
			}
			select {
			case actions <- out:
			default:
				fmt.Printf("[ink] action dropped: router link backed up\n")
			}
		case bytes.HasPrefix(line, []byte("err")) || bytes.HasPrefix(line, []byte("ok g")):
			fmt.Printf("[ink] extension: %s\n", line)
		default:
			if debug {
				fmt.Printf("[ink] extension: %s\n", line)
			}
		}
	}
}
