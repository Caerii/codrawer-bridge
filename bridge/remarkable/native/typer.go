package main

// Replies typed into the tablet (ADR 005, reply sinks), and how fast.
//
// The desktop router can attach a terminal agent (Claude Code through even-terminal) to the
// session; its answers come back as `term` messages (docs/protocol.md). With -type-replies the
// bridge types them, through a virtual keyboard (uinput.go), into whatever text field the user
// has focused in xochitl, so a `/term` question typed on the paired keyboard and its answer both
// end up in the tablet's own document. Verified on hardware (CLAUDE.md, "Where things stand").
//
// How fast it types is a speed preset the user picks (typerSettings), changeable at runtime with
// a `typer_config` message from the router: the bridge applies it at once, answers with an
// acknowledgement, and announces its speed on every new connection so the router can hold the
// current one for late joiners (bridge.go). The Rust engine's typer.rs is the same design; its
// overview carries the measurements this one rests on, summarised here.
//
// What xochitl accepts (one careful run into a scratch text box, 2026-10-06,
// docs/investigations/keyboard-latency.md, "Typer"):
//
//   - Letters, digits and @#$%&*()-_=+;:'",.<>/?| arrived complete and in order.
//   - ^ [ ] { } ` ~ never arrive, at any pace: xochitl's text field produces nothing for those
//     keys. plan leaves them out (xochitlDrops) and the typer logs what it skipped.
//   - The first ~16 keys after a leading Enter were lost: either xochitl drops keys while it
//     lays out a new paragraph, or a leading "--" triggers an autoformat. Until the next run
//     tells which, every write that ends with Enter is followed by at least enterMs (150 ms).

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
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

// typerForever owns the virtual keyboard and types whatever arrives on in, paced as shared says
// when each reply starts (a typer_config takes effect from the next reply). If the device cannot
// be created (no /dev/uinput yet) it retries every 10 s; after a write failure it reopens.
func typerForever(in <-chan string, shared *sharedTyper, debug bool) {
	for {
		kb, err := OpenVirtualKeyboard(virtualKeyboardName)
		if err != nil {
			fmt.Printf("[typer] virtual keyboard unavailable (%v); retrying in 10s\n", err)
			time.Sleep(10 * time.Second)
			continue
		}
		fmt.Printf("[typer] virtual keyboard ready (%+v)\n", shared.get())
		for s := range in {
			now := shared.get()
			if debug {
				fmt.Printf("[typer] %q (%+v)\n", s, now)
			}
			if skipped := untypable(s); skipped != "" {
				fmt.Printf("[typer] skipped %q: xochitl's text field drops them\n", skipped)
			}
			if err := kb.TypeText(s, now); err != nil {
				fmt.Printf("[typer] write failed (%v); reopening\n", err)
				break
			}
		}
		kb.Close()
		time.Sleep(2 * time.Second)
	}
}

// ── speeds ──────────────────────────────────────────────────────────────────────────────────────
//
// A reply becomes bursts, each one write() of whole key frames and then a pause. Every keystroke
// is always its own frames (Shift down, key down, SYN, key up, Shift up, SYN), exactly what a
// real keyboard produces, so no consumer ever sees two keys in one frame. A speed only decides how
// frames are grouped into writes and how long the pause after each is (charMs):
//
//	careful   one keystroke per write, 12 ms: the pacing verified on hardware (~4.8 s / 400 chars)
//	fast      a word and its separator (≤ typeWordMax keys), 12 ms (~0.9 s / 400 chars)
//	instant   up to burst keystrokes (default 10), never past an Enter, 40 ms (~1.6 s / 400 chars)
//
// instant is NOT calibrated yet: its defaults are conservative guesses until xochitl's real limit
// is measured. The burst cap rests on an unverified reading of the kernel: evdev gives each reader
// of a keyboard like this one a 64-event buffer and a keystroke is 4 events (6 with Shift), so a
// write of more than ~10 keystrokes can overflow it if xochitl is not reading at that moment.
//
// The environment sets the starting speed: TYPE_SPEED (careful|fast|instant), else TYPE_BATCH=word
// (the older switch) for fast, else careful; TYPE_CHAR_MS (> 0) replaces the preset's pause,
// TYPE_BURST the instant burst and TYPE_ENTER_MS (≥ 0) the settle after Enter.

// typeSpeed is a typing speed preset (typer_config.speed, TYPE_SPEED).
type typeSpeed string

const (
	speedCareful typeSpeed = "careful"
	speedFast    typeSpeed = "fast"
	speedInstant typeSpeed = "instant"
)

// parseSpeed reads a wire name (case and surrounding space ignored).
func parseSpeed(s string) (typeSpeed, bool) {
	switch sp := typeSpeed(strings.ToLower(strings.TrimSpace(s))); sp {
	case speedCareful, speedFast, speedInstant:
		return sp, true
	}
	return "", false
}

// defaultCharMs is the preset's pause after each write, ms.
func (sp typeSpeed) defaultCharMs() int {
	if sp == speedInstant {
		return 40 // uncalibrated: see above
	}
	return 12
}

const (
	typeWordMax     = 16          // the most keystrokes one word burst carries; a longer "word" is split
	typeBurstMax    = typeWordMax // the largest burst a typer_config or TYPE_BURST may ask for
	typeBurstDef    = 10          // instant's keystrokes per write by default
	typeCharMsMax   = 1000        // the longest pause one may ask for, ms
	typeEnterMsDef  = 150         // the settle after a write that ends with Enter, ms
	typeEnterMsMax  = 2000
	xochitlDrops    = "^[]{}`~" // characters xochitl's text field produces nothing for (measured)
	keySpace        = 57        // the Linux key code of the space bar
	typerConfigType = "typer_config"
)

// typerSettings is the typer's pacing. JSON field names are the wire's (typer_config).
type typerSettings struct {
	Speed   typeSpeed `json:"speed"`
	CharMs  int       `json:"char_ms"`  // pause after each write, 1..typeCharMsMax
	Burst   int       `json:"burst"`    // keystrokes per write for instant, 1..typeBurstMax
	EnterMs int       `json:"enter_ms"` // least pause after a write ending with Enter, 0..typeEnterMsMax
}

// presetSettings is a preset with its own pause, the default burst and Enter settle.
func presetSettings(sp typeSpeed) typerSettings {
	return typerSettings{Speed: sp, CharMs: sp.defaultCharMs(), Burst: typeBurstDef, EnterMs: typeEnterMsDef}
}

// typerSettingsFromEnv builds the starting settings (see above): charMs 0 = the preset's,
// burst 0 = the default, enterMs < 0 = the default; out-of-range values are clamped.
func typerSettingsFromEnv(speed, batch string, charMs, burst, enterMs int) typerSettings {
	sp, ok := parseSpeed(speed)
	if !ok {
		sp = speedCareful
		if strings.EqualFold(strings.TrimSpace(batch), "word") {
			sp = speedFast
		}
	}
	s := presetSettings(sp)
	if charMs > 0 {
		s.CharMs = min(charMs, typeCharMsMax)
	}
	if burst > 0 {
		s.Burst = min(burst, typeBurstMax)
	}
	if enterMs >= 0 {
		s.EnterMs = min(enterMs, typeEnterMsMax)
	}
	return s
}

// typerSettingsFromProcess reads TYPE_SPEED, TYPE_BATCH, TYPE_BURST and TYPE_ENTER_MS from the
// environment; charMs comes from -type-char-ms / TYPE_CHAR_MS.
func typerSettingsFromProcess(charMs int) typerSettings {
	num := func(k string, unset int) int {
		if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(k))); err == nil {
			return v
		}
		return unset
	}
	return typerSettingsFromEnv(os.Getenv("TYPE_SPEED"), os.Getenv("TYPE_BATCH"), charMs, num("TYPE_BURST", 0), num("TYPE_ENTER_MS", -1))
}

// sharedTyper holds the settings the socket reader changes and the typer thread reads.
type sharedTyper struct {
	mu sync.Mutex
	s  typerSettings
}

func (t *sharedTyper) get() typerSettings {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.s
}

// apply runs applyTyperConfig under the lock.
func (t *sharedTyper) apply(data []byte) ([]byte, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return applyTyperConfig(data, &t.s)
}

// ── typer_config: change and report the speed ───────────────────────────────────────────────────

// typerAck is the acknowledgement: the settings now in force; ok false (with error) for a refused
// request. Clients show it; routers keep the latest ok:true one for late joiners.
type typerAck struct {
	T string `json:"t"`
	typerSettings
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func ackTyper(s typerSettings, errText string) []byte {
	b, _ := json.Marshal(typerAck{typerConfigType, s, errText == "", errText})
	return b
}

// applyTyperConfig applies a typer_config request to s and returns the acknowledgement to send;
// false for anything that is not a request (other types, or an acknowledgement, which carries
// ok). A request with no fields only asks for the settings. A speed resets the pause to that
// preset's before char_ms (if given) adjusts it; char_ms, burst or enter_ms alone adjust the
// current speed. A bad value refuses the whole request and leaves s unchanged.
func applyTyperConfig(data []byte, s *typerSettings) ([]byte, bool) {
	var m struct {
		T       string  `json:"t"`
		Speed   *string `json:"speed"`
		CharMs  *int    `json:"char_ms"`
		Burst   *int    `json:"burst"`
		EnterMs *int    `json:"enter_ms"`
		OK      *bool   `json:"ok"`
	}
	if json.Unmarshal(data, &m) != nil || m.T != typerConfigType || m.OK != nil {
		return nil, false
	}
	next := *s
	if m.Speed != nil {
		sp, ok := parseSpeed(*m.Speed)
		if !ok {
			return ackTyper(*s, "speed must be careful, fast or instant"), true
		}
		next.Speed, next.CharMs = sp, sp.defaultCharMs()
	}
	if m.CharMs != nil {
		if *m.CharMs < 1 || *m.CharMs > typeCharMsMax {
			return ackTyper(*s, "char_ms must be 1..1000"), true
		}
		next.CharMs = *m.CharMs
	}
	if m.Burst != nil {
		if *m.Burst < 1 || *m.Burst > typeBurstMax {
			return ackTyper(*s, "burst must be 1..16"), true
		}
		next.Burst = *m.Burst
	}
	if m.EnterMs != nil {
		if *m.EnterMs < 0 || *m.EnterMs > typeEnterMsMax {
			return ackTyper(*s, "enter_ms must be 0..2000"), true
		}
		next.EnterMs = *m.EnterMs
	}
	*s = next
	return ackTyper(*s, ""), true
}

// dockRequest is the typer_config request a tap in the tablet's dock stands for: a dock_action
// whose id is typer_careful, typer_fast or typer_instant (entries listed in
// /run/codrawer/dock.json, docs/protocol.md). The bridge applies it as if the router had sent
// it; the dock_action itself is still relayed like any other.
func dockRequest(data []byte) ([]byte, bool) {
	var a struct {
		T  string `json:"t"`
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &a) != nil || a.T != "dock_action" || !strings.HasPrefix(a.ID, "typer_") {
		return nil, false
	}
	sp, ok := parseSpeed(strings.TrimPrefix(a.ID, "typer_"))
	if !ok {
		return nil, false
	}
	b, _ := json.Marshal(map[string]string{"t": typerConfigType, "speed": string(sp)})
	return b, true
}

// ── the plan for one reply ──────────────────────────────────────────────────────────────────────

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

// untypable returns the characters of s that plan leaves out because xochitl drops them.
func untypable(s string) string {
	var b strings.Builder
	for _, r := range s {
		if strings.ContainsRune(xochitlDrops, r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// plan returns the writes that type s (US layout, see keystrokes; untypable characters left
// out), grouped and paced as how says.
func plan(s string, how typerSettings) []burst {
	typable := strings.Map(func(r rune) rune {
		if strings.ContainsRune(xochitlDrops, r) {
			return -1
		}
		return r
	}, s)
	pause := time.Duration(how.CharMs) * time.Millisecond
	settle := max(pause, time.Duration(how.EnterMs)*time.Millisecond)
	var out []burst
	cur := burst{pause: pause}
	keys := 0
	for _, ks := range keystrokes(typable) {
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
		var ends bool
		switch how.Speed {
		case speedFast:
			ends = keys >= typeWordMax || ks.code == keySpace || ks.code == keyTab
		case speedInstant:
			ends = keys >= max(1, how.Burst)
		default:
			ends = true
		}
		if ks.code == keyEnter {
			ends, cur.pause = true, settle
		}
		if ends {
			out = append(out, cur)
			cur = burst{pause: pause}
			keys = 0
		}
	}
	if len(cur.events) > 0 {
		out = append(out, cur)
	}
	return out
}
