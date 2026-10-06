package main

// Replies typed into the tablet (ADR 005, reply sinks): the uinput typer, its speeds, its keymap
// and its gate.
//
// The desktop router can attach a terminal agent (Claude Code through even-terminal) to the
// session; its answers come back as `term` messages (docs/protocol.md). With -type-replies the
// bridge puts them into whatever text box the user has focused in xochitl: through the
// codrawer-layer extension when it runs (agent_ink.go, "Text"), otherwise by typing them on a
// virtual keyboard (uinput.go). This file is that fallback. The Rust engine's typer.rs is the
// same design; its overview carries the facts in full. In short
// (docs/investigations/keyboard-and-text.md, § 2):
//
//  1. xochitl translates keys with its own Type Folio tables (libepaper.so), one per keyboard
//     language. Under "United States" no key produces [ ] { } ^ ` ~, and the PC keys for five of
//     them are dead keys. The typer's keymap is generated from those tables
//     (scripts/dev/epaper_keymap.py --typer → epaper_keymaps.json, embedded), chosen by xochitl's
//     InputLocale; what the table cannot type is left out (or substituted) and reported in a
//     typer_note.
//  2. xochitl ignores keys while the pen is close or a touch is down. typerGate holds each write
//     until both are clear for typeClearMs.
//  3. A pen stroke leaves text mode: before a reply that follows pen activity or a pause, the
//     typer presses End and waits typePrimeMs.
//  4. Every write that ends with Enter is followed by at least enter_ms (150 ms).
//  5. The pace is a speed preset (careful, fast, instant), changeable with typer_config.

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

// typerForever owns the virtual keyboard and types whatever arrives on in, as shared says when
// each reply starts. Before every write it waits for the gate and primes text mode when needed;
// characters the keymap cannot type go out on notes as a typer_note. If the device cannot be
// created (no /dev/uinput yet) it retries every 10 s; after a write failure it reopens.
func typerForever(in <-chan string, shared *sharedTyper, notes chan<- []byte, debug bool) {
	p := pace{lastKey: time.Now().Add(-time.Minute), activity: ^uint64(0)}
	for {
		kb, err := OpenVirtualKeyboard(virtualKeyboardName)
		if err != nil {
			fmt.Printf("[typer] virtual keyboard unavailable (%v); retrying in 10s\n", err)
			time.Sleep(10 * time.Second)
			continue
		}
		fmt.Printf("[typer] virtual keyboard ready (%+v, keymap %s)\n", shared.get(), shared.keymap.Name)
	replies:
		for s := range in {
			now := shared.get()
			if debug {
				fmt.Printf("[typer] %q (%+v)\n", s, now)
			}
			bursts, dropped := plan(s, now, shared.keymap)
			if dropped != "" {
				fmt.Printf("[typer] left out %q: the %s keyboard cannot type them\n", dropped, shared.keymap.Name)
				select {
				case notes <- typerNote(dropped, shared.keymap):
				default:
				}
			}
			for _, b := range bursts {
				err := p.ready(kb, debug)
				if err == nil {
					err = kb.writeBurst(b)
				}
				if err != nil {
					fmt.Printf("[typer] write failed (%v); reopening\n", err)
					break replies
				}
				p.typed()
			}
		}
		kb.Close()
		time.Sleep(2 * time.Second)
	}
}

// pace is where the typer stands between writes: when it last pressed a key, and the gate's
// activity count then, so it knows whether xochitl may have left text mode since.
type pace struct {
	lastKey  time.Time
	activity uint64
}

// ready waits until the pen and the hand are off the screen, then re-enters text mode with End
// if there was pen or touch activity, or a pause, since the last key.
func (p *pace) ready(kb *VirtualKeyboard, debug bool) error {
	held := false
	for {
		w := typerGate.wait()
		if w == 0 {
			break
		}
		if !held && debug {
			fmt.Printf("[typer] holding: the pen or a hand is on the screen\n")
		}
		held = true
		time.Sleep(min(w, 50*time.Millisecond))
	}
	if typerGate.activityCount() != p.activity || time.Since(p.lastKey) > typePrimeIdleMs*time.Millisecond {
		return kb.writeBurst(primeBurst())
	}
	return nil
}

func (p *pace) typed() {
	p.lastKey = time.Now()
	p.activity = typerGate.activityCount()
}

// ── speeds ──────────────────────────────────────────────────────────────────────────────────────
//
// A reply becomes bursts, each one write() of whole key frames and then a pause. Every keystroke
// is its own frames (modifiers down, key down, SYN, key up, modifiers up, SYN), as a real
// keyboard produces them. A speed decides only how frames are grouped and how long the pause is:
//
//	careful   one keystroke per write, 12 ms: the pace verified on hardware (~4.8 s / 400 chars)
//	fast      a word and its separator (≤ typeWordMax keys), 12 ms (~0.9 s / 400 chars)
//	instant   up to burst keystrokes (default 10), never past an Enter, 40 ms (~1.6 s / 400 chars)
//
// instant is NOT calibrated yet (scripts/dev/typerbench.py). The environment sets the start:
// TYPE_SPEED, else TYPE_BATCH=word for fast, else careful; TYPE_CHAR_MS (> 0), TYPE_BURST,
// TYPE_ENTER_MS (≥ 0), TYPE_SUBSTITUTE=1 and TYPE_KEYMAP (a table name) adjust it.

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
		return 40 // uncalibrated
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
	typeClearMs     = 300  // pen out of range and screen untouched this long before typing, ms
	typePrimeMs     = 150  // the wait after pressing End to re-enter text mode, ms
	typePrimeIdleMs = 1000 // a reply this long after the last key is primed anyway, ms
	keySpace        = 57
	keyEnd          = 107
	typerConfigType = "typer_config"
)

// typerSettings is the typer's pacing. JSON field names are the wire's (typer_config).
type typerSettings struct {
	Speed      typeSpeed `json:"speed"`
	CharMs     int       `json:"char_ms"`    // pause after each write, 1..typeCharMsMax
	Burst      int       `json:"burst"`      // keystrokes per write for instant, 1..typeBurstMax
	EnterMs    int       `json:"enter_ms"`   // least pause after a write ending with Enter, 0..typeEnterMsMax
	Substitute bool      `json:"substitute"` // stand-ins for characters the keymap cannot type
}

// presetSettings is a preset with its own pause and the defaults for the rest.
func presetSettings(sp typeSpeed) typerSettings {
	return typerSettings{Speed: sp, CharMs: sp.defaultCharMs(), Burst: typeBurstDef, EnterMs: typeEnterMsDef}
}

// typerSettingsFromEnv builds the starting settings: charMs 0 = the preset's, burst 0 = the
// default, enterMs < 0 = the default; out-of-range values are clamped.
func typerSettingsFromEnv(speed, batch string, charMs, burst, enterMs int, substitute bool) typerSettings {
	sp, ok := parseSpeed(speed)
	if !ok {
		sp = speedCareful
		if strings.EqualFold(strings.TrimSpace(batch), "word") {
			sp = speedFast
		}
	}
	s := presetSettings(sp)
	s.Substitute = substitute
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

// xochitlConf is where xochitl keeps its settings, among them the keyboard language.
const xochitlConf = "/home/root/.config/remarkable/xochitl.conf"

// typerFromProcess builds the typer's starting state from the environment (TYPE_SPEED,
// TYPE_BATCH, TYPE_BURST, TYPE_ENTER_MS, TYPE_SUBSTITUTE, TYPE_KEYMAP) and xochitl.conf; charMs
// comes from -type-char-ms / TYPE_CHAR_MS.
func typerFromProcess(charMs int) *sharedTyper {
	num := func(k string, unset int) int {
		if v, err := strconv.Atoi(strings.TrimSpace(os.Getenv(k))); err == nil {
			return v
		}
		return unset
	}
	sub := strings.TrimSpace(os.Getenv("TYPE_SUBSTITUTE"))
	s := typerSettingsFromEnv(os.Getenv("TYPE_SPEED"), os.Getenv("TYPE_BATCH"), charMs, num("TYPE_BURST", 0), num("TYPE_ENTER_MS", -1), sub == "1" || sub == "true" || sub == "yes")
	table := strings.TrimSpace(os.Getenv("TYPE_KEYMAP"))
	if table == "" {
		conf, _ := os.ReadFile(xochitlConf)
		table = tableForLocale(inputLocale(string(conf)))
	}
	return &sharedTyper{s: s, keymap: keymapNamed(table)}
}

// sharedTyper holds what the socket reader changes and the typer goroutine reads: the settings,
// and the keymap chosen at start.
type sharedTyper struct {
	mu     sync.Mutex
	s      typerSettings
	keymap *keymap
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
	return applyTyperConfig(data, &t.s, t.keymap)
}

// ack is the acknowledgement of the settings now.
func (t *sharedTyper) ack() []byte { return ackTyper(t.get(), t.keymap, "") }

// ── the keymap: xochitl's own tables ────────────────────────────────────────────────────────────

// epaperKeymaps is xochitl's Type Folio tables, generated from libepaper.so
// (scripts/dev/epaper_keymap.py --typer). The Rust engine embeds the same file.
//
//go:embed epaper_keymaps.json
var epaperKeymaps []byte

// Modifier bits in the tables (Qt's evdev bits).
const (
	modShift = 1
	modAltGr = 2
)

// typerSubstitutes are readable stand-ins, used with substitute, for characters a table cannot
// type: brackets become parentheses so structure survives; ^ becomes ** (a power).
var typerSubstitutes = map[rune]string{'[': "(", ']': ")", '{': "(", '}': ")", '^': "**", '~': "-", '`': "'"}

// keymap is one keyboard language's table: the key and modifiers that produce each character.
type keymap struct {
	Name    string
	Missing string // the printable ASCII this language cannot type
	keys    map[rune][2]int
}

// keymapNamed returns the table called name, or UnitedStates when there is none by that name.
func keymapNamed(name string) *keymap {
	var all map[string]struct {
		Missing string            `json:"missing"`
		Keys    map[string][2]int `json:"keys"`
	}
	if err := json.Unmarshal(epaperKeymaps, &all); err != nil {
		panic("epaper_keymaps.json: " + err.Error())
	}
	t, ok := all[name]
	if !ok {
		name, t = "UnitedStates", all["UnitedStates"]
	}
	km := &keymap{Name: name, Missing: t.Missing, keys: map[rune][2]int{}}
	for c, k := range t.Keys {
		for _, r := range c {
			km.keys[r] = k
			break
		}
	}
	return km
}

// tableForLocale names the table for xochitl's keyboard language (InputLocale, e.g. en_GB):
// English is US unless British; other languages go by their two-letter code.
func tableForLocale(locale string) string {
	l := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(locale)), "-", "_")
	lang, _, _ := strings.Cut(l, "_")
	switch lang {
	case "en":
		if strings.HasSuffix(l, "_gb") || strings.HasSuffix(l, "_uk") {
			return "UnitedKingdom"
		}
	case "de":
		return "Germany"
	case "fr":
		return "France"
	case "sv":
		return "Sweden"
	case "nb", "nn", "no":
		return "Norway"
	case "da":
		return "Denmark"
	case "es":
		return "Spain"
	case "it":
		return "Italy"
	}
	return "UnitedStates"
}

// inputLocale reads InputLocale from the text of xochitl.conf ("" when it is not set).
func inputLocale(conf string) string {
	for _, l := range strings.Split(conf, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(l), "InputLocale="); ok {
			return strings.Trim(strings.TrimSpace(v), `"`)
		}
	}
	return ""
}

// typerKey is one key to press: Linux key code and modifier bits.
type typerKey struct{ code, mods int }

// typerKeystrokes returns the keystrokes that type s with km, and the characters it could not
// type (in order, with repeats). Newlines become Enter and tabs Tab; typographic dashes, quotes
// and the ellipsis become their ASCII forms when the table lacks them; with substitute,
// typerSubstitutes stand in for the rest where they can. A dead key is never pressed: the
// tables list none as producers.
func typerKeystrokes(s string, km *keymap, substitute bool) ([]typerKey, string) {
	var out []typerKey
	var dropped strings.Builder
	push := func(c rune) bool {
		switch c {
		case '\n':
			out = append(out, typerKey{keyEnter, 0})
		case '\t':
			out = append(out, typerKey{keyTab, 0})
		default:
			k, ok := km.keys[c]
			if !ok {
				return false
			}
			out = append(out, typerKey{k[0], k[1]})
		}
		return true
	}
	typeable := func(p string) bool {
		for _, c := range p {
			if _, ok := km.keys[c]; !ok {
				return false
			}
		}
		return true
	}
	for _, c := range strings.ReplaceAll(s, "\r\n", "\n") {
		if push(c) {
			continue
		}
		plain, has := "", true
		switch c {
		case '…':
			plain = "..."
		case '—', '–', '−':
			plain = "-"
		case '‘', '’':
			plain = "'"
		case '“', '”':
			plain = `"`
		case ' ':
			plain = " "
		default:
			plain, has = typerSubstitutes[c]
			has = has && substitute
		}
		if has && typeable(plain) {
			for _, pc := range plain {
				push(pc)
			}
			continue
		}
		dropped.WriteRune(c)
	}
	return out, dropped.String()
}

// ── the pen and touch gate ──────────────────────────────────────────────────────────────────────

// Multitouch (type B) codes the touch reader follows.
const (
	absMtSlot       = 0x2f
	absMtTrackingID = 0x39
)

// gate says whether the user's pen or hand is on the screen. The pen reader (pen_stream.go) and
// the touch reader (typer_touch.go) feed it every event; the typer reads it before every write.
type gate struct {
	start    time.Time
	mu       sync.Mutex
	penTools uint32 // bit 0 pen, bit 1 rubber: in range
	touches  uint32 // one bit per multitouch slot with a contact
	btnTouch bool
	slot     uint32
	lastMs   int64 // the last pen or touch event, ms since start
	lastSet  bool
	activity atomic.Uint64 // counts pen and touch events, for priming
}

// typerGate is the process's one gate.
var typerGate = newGate()

func newGate() *gate { return &gate{start: time.Now()} }

func (g *gate) nowMs() int64 { return time.Since(g.start).Milliseconds() }

// touched records activity at nowMs; g.mu is held.
func (g *gate) touched(nowMs int64) {
	g.lastMs, g.lastSet = nowMs, true
	g.activity.Add(1)
}

// pen takes one event from the pen device; every event counts as activity (the pen reports only
// while in range).
func (g *gate) pen(etype, code uint16, value int32) { g.penAt(etype, code, value, g.nowMs()) }

func (g *gate) penAt(etype, code uint16, value int32, nowMs int64) {
	if etype == pen.EvSyn {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if etype == pen.EvKey && (code == pen.BtnToolPen || code == pen.BtnToolRubber) {
		bit := uint32(1)
		if code == pen.BtnToolRubber {
			bit = 2
		}
		if value != 0 {
			g.penTools |= bit
		} else {
			g.penTools &^= bit
		}
	}
	g.touched(nowMs)
}

// touch takes one event from the touchscreen (multitouch type B, or BTN_TOUCH).
func (g *gate) touch(etype, code uint16, value int32) { g.touchAt(etype, code, value, g.nowMs()) }

func (g *gate) touchAt(etype, code uint16, value int32, nowMs int64) {
	if etype == pen.EvSyn {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	switch {
	case etype == pen.EvAbs && code == absMtSlot:
		g.slot = uint32(min(max(value, 0), 31))
	case etype == pen.EvAbs && code == absMtTrackingID:
		if value >= 0 {
			g.touches |= 1 << g.slot
		} else {
			g.touches &^= 1 << g.slot
		}
	case etype == pen.EvKey && code == pen.BtnTouch:
		g.btnTouch = value != 0
	}
	g.touched(nowMs)
}

// wait is how long to wait before the next write: zero when the pen is out of range, nothing
// touches the screen and neither has for typeClearMs; otherwise the time left (a poll interval
// while something is still down).
func (g *gate) wait() time.Duration { return g.waitAt(g.nowMs()) }

func (g *gate) waitAt(nowMs int64) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.penTools != 0 || g.touches != 0 || g.btnTouch {
		return 50 * time.Millisecond
	}
	if !g.lastSet {
		return 0
	}
	return time.Duration(max(g.lastMs+typeClearMs-nowMs, 0)) * time.Millisecond
}

func (g *gate) activityCount() uint64 { return g.activity.Load() }

// ── typer_config: change and report the speed ───────────────────────────────────────────────────

// typerAck is the acknowledgement: the settings now in force, the keyboard table and the ASCII it
// cannot type; ok false (with error) for a refused request. Clients show it; routers keep the
// latest ok:true one for late joiners.
type typerAck struct {
	T string `json:"t"`
	typerSettings
	Keymap     string `json:"keymap"`
	Untypeable string `json:"untypeable"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
}

func ackTyper(s typerSettings, km *keymap, errText string) []byte {
	b, _ := json.Marshal(typerAck{typerConfigType, s, km.Name, km.Missing, errText == "", errText})
	return b
}

// applyTyperConfig applies a typer_config request to s and returns the acknowledgement to send;
// false for anything that is not a request (other types, or an acknowledgement, which carries
// ok). A request with no fields only asks for the settings. A speed resets the pause to that
// preset's before char_ms (if given) adjusts it; the other fields alone adjust the current
// speed. A bad value refuses the whole request and leaves s unchanged.
func applyTyperConfig(data []byte, s *typerSettings, km *keymap) ([]byte, bool) {
	var m struct {
		T          string  `json:"t"`
		Speed      *string `json:"speed"`
		CharMs     *int    `json:"char_ms"`
		Burst      *int    `json:"burst"`
		EnterMs    *int    `json:"enter_ms"`
		Substitute *bool   `json:"substitute"`
		OK         *bool   `json:"ok"`
	}
	if json.Unmarshal(data, &m) != nil || m.T != typerConfigType || m.OK != nil {
		return nil, false
	}
	next := *s
	if m.Speed != nil {
		sp, ok := parseSpeed(*m.Speed)
		if !ok {
			return ackTyper(*s, km, "speed must be careful, fast or instant"), true
		}
		next.Speed, next.CharMs = sp, sp.defaultCharMs()
	}
	if m.CharMs != nil {
		if *m.CharMs < 1 || *m.CharMs > typeCharMsMax {
			return ackTyper(*s, km, "char_ms must be 1..1000"), true
		}
		next.CharMs = *m.CharMs
	}
	if m.Burst != nil {
		if *m.Burst < 1 || *m.Burst > typeBurstMax {
			return ackTyper(*s, km, "burst must be 1..16"), true
		}
		next.Burst = *m.Burst
	}
	if m.EnterMs != nil {
		if *m.EnterMs < 0 || *m.EnterMs > typeEnterMsMax {
			return ackTyper(*s, km, "enter_ms must be 0..2000"), true
		}
		next.EnterMs = *m.EnterMs
	}
	if m.Substitute != nil {
		next.Substitute = *m.Substitute
	}
	*s = next
	return ackTyper(*s, km, ""), true
}

// typerNote tells the session what a reply lost: the characters the keyboard table could not
// type (docs/protocol.md, typer_note). The glasses show it next to the terminal.
func typerNote(dropped string, km *keymap) []byte {
	b, _ := json.Marshal(map[string]any{"t": "typer_note", "dropped": dropped, "count": len([]rune(dropped)), "keymap": km.Name})
	return b
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

// keystrokeFrames appends the two frames of one keystroke, its modifiers held around the key.
func keystrokeFrames(k typerKey, out []inputEvent) []inputEvent {
	var held []uint16
	if k.mods&modShift != 0 {
		held = append(held, KEY_LEFTSHIFT)
	}
	if k.mods&modAltGr != 0 {
		held = append(held, KEY_RIGHTALT)
	}
	for _, m := range held {
		out = append(out, inputEvent{pen.EvKey, m, 1})
	}
	code := uint16(k.code)
	out = append(out, inputEvent{pen.EvKey, code, 1}, inputEvent{pen.EvSyn, pen.SynReport, 0}, inputEvent{pen.EvKey, code, 0})
	for i := len(held) - 1; i >= 0; i-- {
		out = append(out, inputEvent{pen.EvKey, held[i], 0})
	}
	return append(out, inputEvent{pen.EvSyn, pen.SynReport, 0})
}

// primeBurst is the write that re-enters xochitl's text mode before a reply: End, then
// typePrimeMs.
func primeBurst() burst {
	return burst{events: keystrokeFrames(typerKey{keyEnd, 0}, nil), pause: typePrimeMs * time.Millisecond}
}

// plan returns the writes that type s, grouped and paced as how says, and the characters left
// out (typerKeystrokes).
func plan(s string, how typerSettings, km *keymap) ([]burst, string) {
	keys, dropped := typerKeystrokes(s, km, how.Substitute)
	pause := time.Duration(how.CharMs) * time.Millisecond
	settle := max(pause, time.Duration(how.EnterMs)*time.Millisecond)
	var out []burst
	cur := burst{pause: pause}
	n := 0
	for _, k := range keys {
		cur.events = keystrokeFrames(k, cur.events)
		n++
		var ends bool
		switch how.Speed {
		case speedFast:
			ends = n >= typeWordMax || k.code == keySpace || k.code == keyTab
		case speedInstant:
			ends = n >= max(1, how.Burst)
		default:
			ends = true
		}
		if k.code == keyEnter {
			ends, cur.pause = true, settle
		}
		if ends {
			out = append(out, cur)
			cur = burst{pause: pause}
			n = 0
		}
	}
	if len(cur.events) > 0 {
		out = append(out, cur)
	}
	return out, dropped
}
