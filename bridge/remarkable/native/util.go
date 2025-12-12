package main

// Small helpers used across the native bridge.

import (
	"fmt"
	"math"
	"os"
	"strings"
	"time"
)

func nowMS() int64 { return time.Now().UnixMilli() }

func clamp01(x float64) float64 {
	if x < 0 {
		return 0
	}
	if x > 1 {
		return 1
	}
	return x
}

func norm(v, vmin, vmax int32) float64 {
	if vmax <= vmin {
		return 0
	}
	return clamp01(float64(v-vmin) / float64(vmax-vmin))
}

func getenvDefault(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func getenvIntDefault(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	var out int
	_, err := fmt.Sscanf(v, "%d", &out)
	if err != nil {
		return def
	}
	return out
}

func getenvFloatDefault(k string, def float64) float64 {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	var out float64
	_, err := fmt.Sscanf(v, "%f", &out)
	if err != nil {
		return def
	}
	if math.IsNaN(out) || math.IsInf(out, 0) {
		return def
	}
	return out
}

func getenvBoolDefault(k string, def bool) bool {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	v = strings.ToLower(strings.TrimSpace(v))
	if v == "1" || v == "true" || v == "yes" || v == "y" {
		return true
	}
	if v == "0" || v == "false" || v == "no" || v == "n" {
		return false
	}
	return def
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}


