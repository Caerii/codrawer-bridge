package agentink

import (
	"strings"
	"testing"
)

const (
	gDoc  = "4c0e2d44-91ad-4d94-a473-ac8187400cd7"
	gPage = "22227dbf-7a9e-4044-b2e8-42711dd3d680"
)

// The same inputs and bytes as the Rust engine's goto tests (agent_ink.rs).
func TestGotoOpFromTheUserGoes(t *testing.T) {
	line, why := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","page":"`+gPage+`","region":[0.1,0.2,0.30004,0.4],"reason":"cited: Lemma 2","origin":"user"}`), "g1")
	want := `{"op":"goto","id":"g1","doc":"` + gDoc + `","page":"` + gPage + `","region":[0.1,0.2,0.3,0.4],"flash":true,"mode":"go","reason":"cited: Lemma 2"}`
	if why != "" || string(line) != want {
		t.Fatalf("got %s (%s)\nwant %s", line, why, want)
	}
}

func TestGotoOpFromAnAgentIsAnOffer(t *testing.T) {
	for _, origin := range []string{`"agent"`, `""`, `null`, `"User"`} {
		line, _ := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","page":3,"origin":`+origin+`}`), "g2")
		want := `{"op":"goto","id":"g2","doc":"` + gDoc + `","page":3,"flash":false,"mode":"offer","reason":""}`
		if string(line) != want {
			t.Fatalf("origin %s: got %s", origin, line)
		}
	}
	line, _ := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`"}`), "g3")
	if !strings.Contains(string(line), `"mode":"offer"`) || strings.Contains(string(line), `"page"`) {
		t.Fatalf("no origin, no page: %s", line)
	}
}

func TestGotoOpPagesAndFlash(t *testing.T) {
	for in, want := range map[string]string{`"12"`: `"page":12`, `0`: `"page":0`, `"` + gPage + `"`: `"page":"` + gPage + `"`} {
		line, why := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","page":`+in+`}`), "g")
		if !strings.Contains(string(line), want) {
			t.Fatalf("page %s: %s (%s)", in, line, why)
		}
	}
	// flash needs a region; with one it defaults on and can be turned off
	line, _ := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","flash":true}`), "g")
	if !strings.Contains(string(line), `"flash":false`) {
		t.Fatalf("flash without a region: %s", line)
	}
	line, _ = GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","region":[0,0,1,1],"flash":false}`), "g")
	if !strings.Contains(string(line), `"flash":false`) {
		t.Fatalf("flash off: %s", line)
	}
}

func TestGotoOpRefusals(t *testing.T) {
	for in, why := range map[string]string{
		`{"t":"page","doc":"` + gDoc + `"}`:                          "not a goto",
		`{"t":"goto","doc":"../../etc"}`:                             "doc must be a uuid",
		`{"t":"goto","doc":"` + gDoc + `","page":"x"}`:                "page must be",
		`{"t":"goto","doc":"` + gDoc + `","page":-1}`:                 "page must be",
		`{"t":"goto","doc":"` + gDoc + `","page":1.5}`:                "page must be",
		`{"t":"goto","doc":"` + gDoc + `","region":[0.3,0.1,0.2,0.4]}`: "region must be",
		`{"t":"goto","doc":"` + gDoc + `","region":[0,0,1]}`:          "region must be",
		`{"t":"goto","doc":"` + gDoc + `","region":[0,0,1,9]}`:        "off the page",
	} {
		line, got := GotoOp([]byte(in), "g")
		if line != nil || !strings.Contains(got, why) {
			t.Fatalf("%s: line %s, why %q, want %q", in, line, got, why)
		}
	}
}

func TestGotoOpConsentHookAndReason(t *testing.T) {
	defer func(f func(string) bool) { ConsentAllows = f }(ConsentAllows)
	ConsentAllows = func(doc string) bool { return doc != gDoc }
	if line, why := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","origin":"user"}`), "g"); line != nil || why != "outside the consent scopes" {
		t.Fatalf("consent: %s %q", line, why)
	}
	ConsentAllows = func(string) bool { return true }
	long := strings.Repeat("é", 130)
	line, _ := GotoOp([]byte(`{"t":"goto","doc":"`+gDoc+`","reason":"  a\u0007\"b`+long+`"}`), "g")
	if !strings.Contains(string(line), `"reason":"a\"b`+strings.Repeat("é", 117)+`"}`) {
		t.Fatalf("reason: %s", line)
	}
}
