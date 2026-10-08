package main

import "testing"

func TestTabletProfiles(t *testing.T) {
	for _, model := range []string{"", "paper-pro"} {
		p, err := profileFor(model)
		if err != nil || p != (tabletProfile{}) {
			t.Fatalf("%q must preserve legacy defaults: %+v, %v", model, p, err)
		}
	}
	p, err := profileFor("rm2")
	if err != nil || p.input != "/dev/input/event1" || !p.swapXY || p.invertX || !p.invertY {
		t.Fatalf("wrong rM2 portrait profile: %+v, %v", p, err)
	}
	if _, err := profileFor("unknown"); err == nil {
		t.Fatal("unknown model must fail instead of silently rotating ink")
	}
}
