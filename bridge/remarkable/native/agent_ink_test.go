package main

import (
	"bufio"
	"net"
	"strings"
	"testing"
	"time"

	"codrawer-bridge-native/agentink"
)

// The extension's greeting turns text insertion on; an insert becomes one op line; an `err`
// answer hands the text to the uinput typer; a refusal of the connection turns it off again.
func TestTextInsertionAndFallback(t *testing.T) {
	bridgeEnd, extEnd := net.Pipe()
	agentInkStateFile = t.TempDir() + "/native_agent_ink"
	link := &inkLink{textC: make(chan string, 4), statusC: make(chan struct{}, 1)}
	typed := make(chan string, 4)
	link.setFallback(func(s string) { typed <- s })
	if link.insertText("too early") {
		t.Fatal("insert offered before the extension said hello")
	}
	done := make(chan struct{})
	page := func() agentink.Page { return agentink.Page{} }
	go readInkReplies(bridgeEnd, make(chan []byte, 1), link, page, false, done)
	go serveInk(bridgeEnd, nil, link, &agentink.Forwarder{}, page, done)

	ext := bufio.NewReader(extEnd)
	readLine := func() string { // the next line that is not a status line
		for {
			l, err := ext.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(l, "status ") {
				return l
			}
		}
	}
	go func() { // the extension's half: the bridge writes the status first
		_, _ = extEnd.Write([]byte("hello codrawer-layer ink text_insert text_read\n"))
	}()
	if l, _ := ext.ReadString('\n'); l != "status codrawer go bridge: connected, agent ink off\n" {
		t.Fatalf("first line %q", l)
	}
	deadline := time.Now().Add(2 * time.Second)
	for !link.textOK.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !link.insertText("a [b] {c} ^ ~\n") {
		t.Fatal("insert not offered after hello")
	}
	line := readLine()
	if want := `{"op":"text_insert","id":"t1","text":"a [b] {c} ^ ~\n"}` + "\n"; line != want {
		t.Fatalf("op line %q, want %q", line, want)
	}
	if _, err := extEnd.Write([]byte("err t1 no focused item\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case s := <-typed:
		if !strings.HasPrefix(s, "a [b]") {
			t.Fatalf("fallback typed %q", s)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("refused insert was not typed")
	}
	// the dock's Agent ink toggle: on, kept, and a new status line
	if _, err := extEnd.Write([]byte(`{"t":"dock_action","id":"agent_ink","page":"p","source":"dock"}` + "\n")); err != nil {
		t.Fatal(err)
	}
	if l, _ := ext.ReadString('\n'); l != "status codrawer go bridge: connected, agent ink on\n" {
		t.Fatalf("status after toggle %q", l)
	}
	if !initialAgentInk(false) {
		t.Fatal("the dock's choice was not kept")
	}
	extEnd.Close()
	<-done
}
