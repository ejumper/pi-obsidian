# PHASE-20 — Voice-mode efficiency pass (heat)

Status: done (0.5.29). Note: measurement hooks landed as `src/views/perf-sample.ts`
(PerfSampler — fps + long-task window, summary logged on voice-mode toggle-off)
rather than a telemetry module (that module no longer exists). User report 2026-11-19: the phone gets hot during voice use; heat
**builds up over time**, tied to long recordings → long runs → long answers. Heat is
the symptom; the fix is efficiency. (Verified non-suspects: TTS blob URLs are
carefully revoked — no leak there.)

## Suspects (ranked)

1. **Render work scales with session length**: every stream delta re-renders BOTH
   the main chat transcript (whole session tree; markdown re-parsed per render)
   AND the voice overlay. Long session × many deltas = the gradual buildup the user
   describes. Prime fix: **memoize message rendering** (React.memo + markdown cache
   keyed by text) so a delta re-renders one message — helps normal mode too.
2. **Hidden work while the overlay is up**: the overlay is fullscreen — pause or
   heavily throttle the main transcript renders while voice mode is visible.
3. **Overlay text re-renders**: throttle slot text to ~200 ms (speech doesn't need
   per-frame text).
4. **Audio pipelines at rest**: suspend AudioContext / analyser RAF when nothing is
   audible or recording.

## Measurement

- Before: sample fps / long-task counts from the phone during a scripted
  long-recording → long-run session (telemetry module hook).
- After: same script; report both in the release notes / changelog.

## Verification

Harness: memoization regression (message render counts don't scale with total
message count on a single-delta update), throttle timing. Device walk: the heat
script above — subjective warmth + the telemetry numbers.
