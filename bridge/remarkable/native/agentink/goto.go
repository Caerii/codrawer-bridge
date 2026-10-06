package agentink

// "Take me there": the router's `goto` message, checked and turned into one socket line for the
// codrawer-layer extension, which opens the document, turns to the page and can flash a region
// (bridge/remarkable/xovi/codrawer-layer/src/navigate.h; docs/protocol.md, "goto").
//
// # Never yank the user
//
// Opening another notebook while the user writes would take the page out from under the pen.
// So the bridge executes a `goto` only when it comes from the user's own action: a tap on a
// citation, a search result or a dock entry, which the client that saw the tap marks
// `"origin":"user"`. Everything else (an agent's suggestion, a message without an origin) becomes
// an offer: the extension shows "Go to …?" in its dock, and only the user's tap on it navigates.
// The extension enforces the same rule on its side (an offer never navigates by itself).
//
// # Consent (ADR 011 §7)
//
// Library sources carry consent scopes, enforced where retrieval happens. The bridge has none of
// that state yet; ConsentAllows is the hook where a scope check goes (a document outside the
// scopes would be refused here, before the extension hears of it). Until then it allows all.
//
// # The socket line
//
//	{"op":"goto","id":"g7","doc":"<uuid>","page":"<uuid>"|<index>,"region":[x0,y0,x1,y1],"flash":true,"mode":"go"|"offer","reason":"…"}
//
// built by hand in a fixed key order, so the Go and Rust engines send the same bytes. `page` and
// `region` are left out when absent; `region` is normalised to the page like every protocol point
// (x = (x_rm + w/2)/w, y = y_rm/h). The extension answers `ok g7 goto …` or `err g7 <why>`.

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ConsentAllows reports whether the user's consent scopes let a `goto` open doc (ADR 011 §7). A
// stub until the scopes reach the tablet: everything is allowed.
var ConsentAllows = func(doc string) bool { return true }

// MaxGotoReason is the longest reason, in characters, shown in the dock's offer.
const MaxGotoReason = 120

type gotoMsg struct {
	T      string          `json:"t"`
	Doc    string          `json:"doc"`
	Page   json.RawMessage `json:"page"`
	Region []float64       `json:"region"`
	Flash  *bool           `json:"flash"`
	Reason string          `json:"reason"`
	Origin string          `json:"origin"`
}

// isUUID: 36 characters of lower- or upper-case hex and dashes in the 8-4-4-4-12 layout.
func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i := 0; i < 36; i++ {
		c := s[i]
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
			continue
		}
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// gotoPage reads `page`: a uuid string, or an index (a number, or a string of digits) 0..99999.
// It returns the JSON to send ("" when absent) or ok=false.
func gotoPage(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if isUUID(s) {
			return string(appendString(nil, s)), true
		}
		if n, err := strconv.Atoi(s); err == nil && n >= 0 && n <= 99999 && len(s) <= 5 {
			return strconv.Itoa(n), true
		}
		return "", false
	}
	var f float64
	if json.Unmarshal(raw, &f) == nil && f == float64(int(f)) && f >= 0 && f <= 99999 {
		return strconv.Itoa(int(f)), true
	}
	return "", false
}

// cleanReason drops control characters and trims to MaxGotoReason characters.
func cleanReason(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if r == utf8.RuneError || unicode.IsControl(r) {
			continue
		}
		if n == MaxGotoReason {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String()
}

// GotoOp checks one router message and returns the socket line for it (nil, and why, when it is
// not a valid `goto`). id names the request in the extension's answer.
func GotoOp(raw []byte, id string) ([]byte, string) {
	var m gotoMsg
	if json.Unmarshal(raw, &m) != nil || m.T != "goto" {
		return nil, "not a goto"
	}
	if !isUUID(m.Doc) {
		return nil, "doc must be a uuid"
	}
	page, ok := gotoPage(m.Page)
	if !ok {
		return nil, "page must be a uuid or an index"
	}
	if m.Region != nil {
		r := m.Region
		if len(r) != 4 || !(r[0] < r[2] && r[1] < r[3]) {
			return nil, "region must be [x0,y0,x1,y1] with x0<x1, y0<y1"
		}
		for _, v := range r {
			if !(v >= -0.5 && v <= 1.5) {
				return nil, "region is off the page"
			}
		}
	}
	if !ConsentAllows(m.Doc) {
		return nil, "outside the consent scopes"
	}
	flash := m.Region != nil
	if m.Flash != nil {
		flash = *m.Flash && m.Region != nil
	}
	mode := "offer"
	if m.Origin == "user" {
		mode = "go"
	}
	b := make([]byte, 0, 160)
	b = append(b, `{"op":"goto","id":`...)
	b = appendString(b, id)
	b = append(b, `,"doc":`...)
	b = appendString(b, m.Doc)
	if page != "" {
		b = append(b, `,"page":`...)
		b = append(b, page...)
	}
	if m.Region != nil {
		b = append(b, `,"region":[`...)
		for i, v := range m.Region {
			if i > 0 {
				b = append(b, ',')
			}
			b = strconv.AppendFloat(b, math.Round(v*1e4)/1e4, 'f', -1, 64) // 0.16 px on a 1620 page
		}
		b = append(b, ']')
	}
	b = append(b, `,"flash":`...)
	b = strconv.AppendBool(b, flash)
	b = append(b, `,"mode":`...)
	b = appendString(b, mode)
	b = append(b, `,"reason":`...)
	b = appendString(b, cleanReason(m.Reason))
	return append(b, '}'), ""
}
