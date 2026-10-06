package main

// The typer's write plan (typer.go): one keystroke per write by default, whole words with
// TYPE_BATCH=word, and the same event stream either way. Linux-only package: see input_test.go
// for running these from Windows.

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"codrawer-bridge-native/pen"
)

const ms12 = 12 * time.Millisecond

func flatten(bs []burst) []inputEvent {
	var out []inputEvent
	for _, b := range bs {
		out = append(out, b.events...)
	}
	return out
}

func TestPlanKeyModeIsOneKeystrokePerWrite(t *testing.T) {
	p := plan("aB", ms12, typeBatchKey)
	if len(p) != 2 {
		t.Fatalf("bursts = %d, want 2", len(p))
	}
	want := []inputEvent{{pen.EvKey, KEY_LEFTSHIFT, 1}, {pen.EvKey, 48, 1}, {pen.EvSyn, pen.SynReport, 0}, {pen.EvKey, 48, 0}, {pen.EvKey, KEY_LEFTSHIFT, 0}, {pen.EvSyn, pen.SynReport, 0}}
	if !reflect.DeepEqual(p[1].events, want) {
		t.Fatalf("B = %v, want %v", p[1].events, want)
	}
	for _, b := range p {
		if b.pause != ms12 {
			t.Fatalf("pause %v", b.pause)
		}
	}
}

func TestPlanWordModeKeepsEveryFrame(t *testing.T) {
	text := "hello world\nok"
	p := plan(text, ms12, typeBatchWord)
	if len(p) != 3 { // "hello ", "world\n", "ok"
		t.Fatalf("bursts = %d, want 3", len(p))
	}
	if !reflect.DeepEqual(flatten(p), flatten(plan(text, ms12, typeBatchKey))) {
		t.Fatal("word mode changed the event stream")
	}
	syns := 0
	for _, e := range flatten(p) {
		if e.etype == pen.EvSyn {
			syns++
		}
	}
	if syns != 2*len(text) {
		t.Fatalf("SYNs = %d, want one per press and per release (%d)", syns, 2*len(text))
	}
}

func TestPlanSplitsLongWords(t *testing.T) {
	var sizes []int
	for _, b := range plan(strings.Repeat("x", 40), ms12, typeBatchWord) {
		sizes = append(sizes, len(b.events)/4)
	}
	if !reflect.DeepEqual(sizes, []int{typeWordMax, typeWordMax, 8}) {
		t.Fatalf("sizes = %v", sizes)
	}
}

func TestTypeBatchFromEnv(t *testing.T) {
	if typeBatchFromEnv(" Word ") != typeBatchWord || typeBatchFromEnv("key") != typeBatchKey || typeBatchFromEnv("") != typeBatchKey {
		t.Fatal("TYPE_BATCH parsing")
	}
}
