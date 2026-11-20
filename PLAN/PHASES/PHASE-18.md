# PHASE-18 — Voice recording lifecycle + chunked STT

Status: §A done (0.5.27, with PHASE-17). §B (chunked STT) planned. User spec 2026-11-19/20. Replaces today's auto-send-on-silence and 5-min cap.

## §A — Recording policy (auto-send is gone)

**Only path to send is double-tap.** (User: "auto send is gone, it was a bad design
choice.") The recorder's timers now pause or discard — they never send.

| trigger | behavior |
|---|---|
| 30 s silence **after audio was registered** | **pause** recording (regular pause — tap resumes). Audio preserved; app/OS lifecycle decides the rest (backgrounding/quit discards naturally) |
| 30 s silence with **no audio registered** | **discard** (= long-press). Accidental-start protection |
| **15 min hard cap** (accumulated recording time — paused time doesn't count) | **auto-pause + hint "message cap reached, double tap to send"** (centered overlay text, persists while cap-paused). The cap is **absolute**: single tap does nothing; only double-tap (send) or long-press (discard) proceed |
| 30 s before the cap | **warning**: recording glow switches to the red 1s-on/1s-off blink (PHASE-17 recipe) |

Numbers: silence window 60 s → **30 s** (both cases share one window; the
audio-registered flag splits the outcome), cap 5 min → **15 min**.

## §B — Chunked STT (manage long audio gracefully — NOT pseudo-streaming)

Goal: the 15-min cap must not hold 15 min of audio in memory, and double-tap must
not stall on minutes of transcription before the model starts. Tuning bias:
**generous chunk sizes** (references — whisper streaming/VAD chunkers — tune for
lowest latency; ours favor fewer, bigger cuts for accuracy).

- **Cut on silence**: when a silence gap ≥ ~2 s arrives AND speech was registered in
  the current chunk AND the chunk is ≥ ~20 s old → cut; force-cut at ~60 s max.
- **Sequential transcription**: chunks upload one at a time (the 1050 Ti
  faster-whisper box is shared — a queue is kinder than bursts).
- **Bounded memory**: each audio chunk is kept only until its text is confirmed,
  then dropped. The partial transcript accumulates; on send, the final chunk flushes
  and the model starts in seconds.
- **Robustness**: chunks containing no speech are never transcribed (whisper
  hallucinates on silence); a failed chunk keeps its audio and is retried at send
  time — text is never silently lost.
- During final-chunk transcription the glow shows the red chaser (PHASE-17).

## Verification

Unit: silence-policy scenarios (registered/unregistered, pause vs discard, cap
absolute + tap-block, warning at threshold) against a fake clock; chunker cut
boundaries (min/max/silence, speech-only chunks, retry-on-failure, drop-after-confirm).
Device walk: 4-min dictation → chunks transcribe during recording → double-tap →
model starts in seconds; pause/resume across a silence; reach the cap on purpose →
blink at 30 s left → hint at cap → send works, tap does not; kill-while-paused →
audio gone (accepted).
