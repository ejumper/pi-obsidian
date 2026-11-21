# PHASE-19 — Voice display: one reply at a time (queue-driven slot)

Status: done (0.5.28), then REWORKED as-built (0.5.30/0.5.31/0.5.32 device feedback).
The as-built model differs from the original spec below: content is REPLACE-ON-ARRIVAL
over one priority chain (read head > streaming reply > sticky activity phrase > last
completed reply > nothing) — "always something on screen", tool-call/thinking phrases
are STICKY through gaps, the final reply stays until a newer reply replaces it (no
generation counters, no final-capture at run end — both raced). The speech queue is
the only event state; everything else derives live from the store. Tail utterances
are TEXT-tracked (the original messages.length sentinel drifted when entries appended
mid-stream — split replies, stale-index black screens), slot entries carry idx -1
until the reply lands (`utterance_landed` repairs by text match), and the landing
resolver matches snapshots by extension (`replyTextMatches` — exact equality once
re-begun a landed reply: the ancient double-read bug). See
`Guides/Desktop/Programs/Pi-Obsidian/.Architecture/1_2-voice-mode.md` (Display slot)
for the current behavior. User spec 2026-11-19/20. Replaces `setLastMessage(msg, streaming)` —
today's overlay renders the last completed message AND the streaming tail at once
(`computeTranscriptUnits`), which is exactly the "multiple replies on screen" bug
(intermediate+final, or prev-final+next-final; self-corrects when the stream ends).

## The model (user's words, reconciled)

The priority is to show **responses**. One slot. A response appears as soon as its
text starts streaming — unless a queue exists (previous response still being read),
in which case **the display follows playback**:

| condition | slot shows |
|---|---|
| TTS is reading response N | N (frozen at final text) — **"a message is displayed until TTS finishes"** |
| TTS's current target N is still generating | N streaming live ("displays as is and continues streaming in" when it reaches the queue top mid-generation) |
| between replies (nothing to read) | the model's current action: tool call, thinking, or run state |
| idle after a run | the final response (stays for tap-to-repeat) |

Lifecycle rules:
- **intermediate** responses go away when TTS finishes reading them (or the user
  skips them — skip = finished) → the slot picks up the model's current action
  ("when an intermediate reply finishes and there's no more replies in the queue it
  picks up at the models current action").
- **final** responses go away when the **next run starts** — with one precedence
  carve-out: if TTS is still mid-read of that final when the next run starts,
  **being read wins**; the slot advances when the read completes or is stopped.
- **stopped final** stays on screen (it is "the response on screen" for tap-to-repeat
  per PHASE-17); a new streaming response or a new run supersedes it.
- tool calls show **only when there is no response to display**.

## Implementation shape

- The slot is driven by the **utterance lifecycle** the TTS layer already has
  (begin/end per assistant message + FIFO playback position + the PHASE-17 mute
  flag): display follows "what is playing" first, "what is streaming" second,
  activity third, last final fourth.
- `setLastMessage` → `setSlot(...)`; `computeTranscriptUnits` shrinks to a single
  unit. The message renderer stays (read-aloud button, markdown, collapse).
- Queue = the TTS FIFO across utterances (PHASE-17's skip already walks it).
- Display and TTS consume the same completion events, so "read finished" and
  "slot advances" can never disagree.

## Verification

Harness: slot-state scenarios (stream-start display, queue override while reading,
mid-generation arrival at queue top, intermediate-clear → activity, final-clear on
next run with mid-read carve-out, stopped-final sticky + repeat) driving the built
bundle. Device walk: a run with 2–3 intermediate replies + tools + a final; watch
the slot through reads, skips, and a stopped final.
