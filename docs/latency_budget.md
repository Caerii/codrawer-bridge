# Latency budget + rate limits

This system is designed for **low-latency ink** and **bounded AI cost**.

## Targets

- **Local ink**: <16ms (client-side rendering target)
- **Network stroke routing**: low tens of ms on LAN
- **AI ghost ink**: ~300–900ms after `stroke_end` (best effort, model dependent)

## Hard constraints

### Model rate limit (50 RPM)

50 requests/minute \(RPM\) \(\approx 0.83\) requests/second.

Server policy:
- Trigger AI work **only** on `stroke_end` (micro-pauses may be added later).
- Enforce a **minimum interval** between model calls (`MIN_MODEL_INTERVAL_S`).
- Debounce inputs (`DEBOUNCE_S`) to batch close-together `stroke_end`s.

## Practical guidance

- Do not send full canvas state; send only incremental strokes.
- Chunk `stroke_pts` and `ai_stroke_pts` for smooth streaming.
- Keep message sizes small to reduce jitter and GC pressure.


