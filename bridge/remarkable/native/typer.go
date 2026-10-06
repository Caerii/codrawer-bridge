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
	"os"
	"strings"
	"time"

	"codrawer-bridge-native/pen"
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
	batch := typeBatchFromEnv(os.Getenv("TYPE_BATCH"))
	for {
		kb, err := OpenVirtualKeyboard(virtualKeyboardName)
		if err != nil {
			fmt.Printf("[typer] virtual keyboard unavailable (%v); retrying in 10s\n", err)
			time.Sleep(10 * time.Second)
			continue
		}
		fmt.Printf("[typer] virtual keyboard ready (%s batches, %v pause)\n", batch, perChar)
		for s := range in {
			if debug {
				fmt.Printf("[typer] %q\n", s)
			}
			if err := kb.TypeText(s, perChar, batch); err != nil {
				fmt.Printf("[typer] write failed (%v); reopening\n", err)
				break
			}
		}
		kb.Close()
		time.Sleep(2 * time.Second)
	}
}

// ── how a reply becomes writes ──────────────────────────────────────────────────────────────────
//
// xochitl has to keep up with the virtual keyboard, so keystrokes are paced: by default one every
// TYPE_CHAR_MS (12 ms), the pacing verified on hardware; a 400-character answer takes ~4.8 s.
// plan turns a reply into bursts, each one write() of whole key frames and then a pause. Every
// keystroke is always its own frames (Shift down, key down, SYN, key up, Shift up, SYN), exactly
// what a real keyboard produces, so no consumer ever sees two keys in one frame. The mode only
// decides how frames are grouped into writes and where the pauses go:
//
//   - typeBatchKey (default): one keystroke per write, perChar after each, as before. Still the
//     default because faster typing into xochitl is not yet verified on the device
//     (docs/investigations/keyboard-latency.md, "Typer").
//   - typeBatchWord (TYPE_BATCH=word): a word and the separator that ends it (space, Enter, Tab),
//     at most typeWordMax keystrokes, in one write, then one perChar pause: ~70 words, ~0.9 s.
//
// The Rust engine's typer.rs is the same plan.

// typeBatch is how keystrokes are grouped into writes (TYPE_BATCH).
type typeBatch int

const (
	typeBatchKey typeBatch = iota
	typeBatchWord
)

func (b typeBatch) String() string {
	if b == typeBatchWord {
		return "Word"
	}
	return "Key"
}

// typeWordMax is the most keystrokes one word burst carries; a longer "word" is split.
const typeWordMax = 16

// keySpace is the Linux key code of the space bar.
const keySpace = 57

// typeBatchFromEnv reads TYPE_BATCH: "word" selects word bursts, anything else one key per write.
func typeBatchFromEnv(v string) typeBatch {
	if strings.EqualFold(strings.TrimSpace(v), "word") {
		return typeBatchWord
	}
	return typeBatchKey
}

// inputEvent is one input_event's type, code and value.
type inputEvent struct {
	etype, code uint16
	value       int32
}

// burst is one write to the virtual keyboard and the pause after it.
type burst struct {
	events []inputEvent
	pause  time.Duration
}

// plan returns the writes that type s (US layout, see keystrokes), paced by perChar.
func plan(s string, perChar time.Duration, batch typeBatch) []burst {
	var out []burst
	cur := burst{pause: perChar}
	keys := 0
	for _, ks := range keystrokes(s) {
		code := uint16(ks.code)
		if ks.shift {
			cur.events = append(cur.events, inputEvent{pen.EvKey, KEY_LEFTSHIFT, 1})
		}
		cur.events = append(cur.events, inputEvent{pen.EvKey, code, 1}, inputEvent{pen.EvSyn, pen.SynReport, 0}, inputEvent{pen.EvKey, code, 0})
		if ks.shift {
			cur.events = append(cur.events, inputEvent{pen.EvKey, KEY_LEFTSHIFT, 0})
		}
		cur.events = append(cur.events, inputEvent{pen.EvSyn, pen.SynReport, 0})
		keys++
		ends := batch == typeBatchKey || keys >= typeWordMax || ks.code == keySpace || ks.code == keyEnter || ks.code == keyTab
		if ends {
			out = append(out, cur)
			cur = burst{pause: perChar}
			keys = 0
		}
	}
	if len(cur.events) > 0 {
		out = append(out, cur)
	}
	return out
}
