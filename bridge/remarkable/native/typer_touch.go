package main

// The touchscreen, followed for the typer's gate (typer.go): xochitl ignores keys while a finger
// is down, so the typer waits. Read-only and never grabbed, so xochitl sees every touch as
// before. The pen side of the gate is fed by the pen reader (pen_stream.go).

import (
	"fmt"
	"os"
	"strings"
	"time"

	"codrawer-bridge-native/pen"
)

// touchGateForever feeds every touchscreen event to typerGate for the life of the process.
// explicit is a device path, "auto" or "" (the first device whose name says touch: the Paper
// Pro's "Elan touch input") or "off".
func touchGateForever(explicit string) {
	if strings.EqualFold(explicit, "off") {
		return
	}
	buf := make([]byte, 64*24)
	for {
		path := explicit
		if path == "" || strings.EqualFold(path, "auto") {
			path = findTouchscreen(listProcInputDevices())
		}
		if path == "" {
			fmt.Printf("[typer] no touchscreen found; the typer waits for the pen only (retrying in 60s)\n")
			time.Sleep(60 * time.Second)
			continue
		}
		f, err := os.Open(path)
		if err != nil {
			fmt.Printf("[typer] touchscreen %s unavailable (%v)\n", path, err)
			time.Sleep(10 * time.Second)
			continue
		}
		fmt.Printf("[typer] following touches on %s\n", path)
		parser := &inputParser{}
		for {
			n, err := f.Read(buf)
			if err != nil {
				break
			}
			parser.feed(buf[:n], func(ev pen.Event) { typerGate.touch(ev.Type, ev.Code, ev.Value) })
		}
		f.Close()
		time.Sleep(10 * time.Second)
	}
}

// findTouchscreen picks the first real (not uinput) device whose name contains "touch".
func findTouchscreen(devices []inputDeviceInfo) string {
	for _, d := range devices {
		if d.virtual || !strings.Contains(strings.ToLower(d.name), "touch") {
			continue
		}
		for _, h := range d.handlers {
			if strings.HasPrefix(h, "event") {
				return "/dev/input/" + h
			}
		}
	}
	return ""
}
