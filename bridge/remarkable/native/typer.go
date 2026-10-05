package main

// Replies typed into the tablet (ADR 005, reply sinks).
//
// The desktop router can attach a terminal agent (Claude Code through even-terminal) to the
// session; its answers come back as `term` messages (docs/protocol.md). With -type-replies the
// bridge types them, through a virtual keyboard (uinput.go), into whatever text field the user
// has focused in xochitl, so a `/term` question typed on the paired keyboard and its answer both
// end up in the tablet's own document. Verified on hardware (CLAUDE.md, "Where things stand").

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// termMsg is the subset of a `term` broadcast the typer cares about.
type termMsg struct {
	T    string `json:"t"`
	Kind string `json:"kind"`
	Text string `json:"text"`
}

// typedReply decides what, if anything, to type for one message from the router. Streamed
// assistant text ("text", already coalesced into chunks by the router) is typed as is; notes,
// permission prompts and questions get a line of their own. The note echoing the prompt
// ("> …") is skipped, because the user typed the prompt already; status and anything that is
// not a `term` message are ignored.
func typedReply(data []byte) (string, bool) {
	var m termMsg
	if err := json.Unmarshal(data, &m); err != nil || m.T != "term" {
		return "", false
	}
	switch m.Kind {
	case "text":
		return m.Text, true
	case "note":
		if strings.HasPrefix(m.Text, "> ") {
			return "", false
		}
		return "\n" + m.Text + "\n", true
	case "permission", "question":
		return "\n" + m.Text + "\n", true
	}
	return "", false
}

// typerForever owns the virtual keyboard and types whatever arrives on in. If the device cannot
// be created (no /dev/uinput yet) it retries every 10 s; after a write failure it reopens.
func typerForever(in <-chan string, perChar time.Duration, debug bool) {
	for {
		kb, err := OpenVirtualKeyboard(virtualKeyboardName)
		if err != nil {
			fmt.Printf("[typer] virtual keyboard unavailable (%v); retrying in 10s\n", err)
			time.Sleep(10 * time.Second)
			continue
		}
		fmt.Printf("[typer] virtual keyboard ready\n")
		for s := range in {
			if debug {
				fmt.Printf("[typer] %q\n", s)
			}
			if err := kb.TypeText(s, perChar); err != nil {
				fmt.Printf("[typer] write failed (%v); reopening\n", err)
				break
			}
		}
		kb.Close()
		time.Sleep(2 * time.Second)
	}
}
