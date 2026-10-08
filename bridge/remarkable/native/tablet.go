package main

import "fmt"

// Model defaults are separate from shared input/router logic. Explicit PEN_* and
// INPUT_DEVICE settings still override them. Empty retains the legacy Pro setup.
type tabletProfile struct {
	input                    string
	swapXY, invertX, invertY bool
}

func profileFor(model string) (tabletProfile, error) {
	switch model {
	case "", "paper-pro":
		return tabletProfile{}, nil // preserve automatic pen discovery
	case "rm2":
		return tabletProfile{input: "/dev/input/event1", swapXY: true, invertY: true}, nil
	default:
		return tabletProfile{}, fmt.Errorf("unknown CODRAWER_TABLET_MODEL: %q", model)
	}
}
