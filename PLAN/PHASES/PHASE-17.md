# PHASE-17 — Voice input & glow semantics

Status: done (0.5.27). User spec settled 2026-11-19/20 after a full design discussion
(the gesture×glow reconciliation — see `SCRATCHPAD` history). This phase is the
**interaction layer**: what each touch does, decided by glow color, and what the glow shows.

## Core principle (user's keystone)

**The touch actions apply to the glow.** The glow color tells the user which gesture
family is live: red = recording actions, green = TTS actions, white = run actions,
no glow = repeat/record/none. To record, the user "removes the glow" first:
TTS active (green) → double-tap, then double-tap. Run active (white) → long-press,
then double-tap. Nothing happening → just double-tap.

**No follow-up recordings (Gap D decision, option #1).** Recording starts only from
full idle. A run cannot start while recording (send ends recording first) and a
recording cannot start while a run is active. Consequence: "record while TTS plays"
is *structurally unreachable* — no suppression policy needed. Mid-run input = stop
the run (long-press), then record. (Option #2 — queue follow-ups during runs — is a
documented future enhancement; it becomes cheap after PHASE-19's queue machinery.)

## Gesture map (total over states)

Recording = `recording !== "off"` (on or paused). Green = `playback !== "off"`
(playing / paused / synthesizing — "anytime the glow is green"). White = `runActive`
with playback off. Idle = none of the above.

| gesture | red (recording) | green (TTS) | white (run) | idle |
|---|---|---|---|---|
| single tap | pause / resume recording (**tap is a no-op when cap-paused** — absolute cap) | pause / resume playback | nothing | **repeat** the response on screen (from the top) |
| double tap | **finish & send** (STT → prompt). *No registered audio = nothing* | **stop/skip**: halt audible playback of the current utterance now; its synthesis **finishes into the replay cache but never plays**; the next queued message starts (queue empty → full stop, glow off) | **nothing** (no follow-ups) | **start recording** |
| long press | **discard recording** (always, even empty) | stop run if a run is active ("you are not going to get the rest of this run"); else nothing | **stop run** | nothing |

- Double-tap semantics = "starts and finishes things but doesn't lose anything":
  sends land the recording in the session; stopped playback leaves the text in the
  session **and the synthesized audio in the replay cache** (tap = instant repeat).
  Long-press = the destructive action: it *loses* content.
- `hold_cancel` (slide-off before the 1s threshold) = **no action** — destructive
  needs the full hold. (Was: legacy discard-on-slide-off.)
- The stop-run **3…2…1 countdown is retired**: long-press fires at threshold. The
  dedicated STOP button stays as the safe path.
- Repeat = from the top ("started over"), never resume-from-position.

## Glow spec (total)

Precedence: **red > green > white > off**. (Recording is idle-only by construction,
so red is only ever contested by nothing.)

| glow | state |
|---|---|
| red, audio visualizer→**breath** | recording (the mic visualizer was tried in 0.5.2 and reverted — envelope read as static; breath stays per user 2026-11-20) |
| red static | recording paused (tap-pause, silence-pause, or cap-pause) |
| red chaser | **waiting for STT** to finish after send (split out of today's white "connecting") |
| red blink 1s on / 1s off | **cap warning** — 30 s of recording time left (replaces the breath while it runs) |
| white chaser | connecting to model / waiting for prefill |
| white breath | run active |
| green chaser | TTS synthesizing (nothing audible yet) |
| green audio visualizer | TTS playing (amp-driven; **beats green chaser** — visualizer when audible, chaser when only processing) |
| green static | TTS playback paused |
| off | idle. A muted (skipped) utterance finishing its synthesis in the background shows **no glow** |

## State-machine notes

- `VoiceUi` gains orthogonal flags: `sttWait` (red chaser), `capWarning` (blink),
  `capReached` (absolute cap — tap cannot resume), `hasAudio` (double-tap send
  guard + silence policy input). `countdown` and the countdown events go away.
- New reducer events: `stt_started/stt_ended`, `cap_warning/cap_reached`,
  `audio_registered`, `silence_pause/silence_discard` (the recorder's auto-actions
  route through the same reducer so every state change is testable).
- TTS skip: new `skipCurrent()` in the TTS layer — mute the open utterance
  (chunks keep synthesizing to the replay cache but never play), stop audible
  playback, continue with the next utterance's chunks if any. The controller
  suppresses glow/speak-state for muted utterances.

## Verification

Gesture scenarios in `test/voice-mode-check.mjs` rewritten to the new map
(including: double-tap-on-white = nothing, cap-paused tap = nothing, double-tap
with no audio = nothing, hold_cancel = no-op, long-press priority recording >
run, skip semantics on green) + glow phase table incl. recording_warning /
stt_waiting / playing_paused. Manual walk on device per PHASE-18's checklist
(recording lifecycle ships together with this phase).
