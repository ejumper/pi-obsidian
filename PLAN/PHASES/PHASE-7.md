# Phase 7 (group A) — Follow-up Output Bug

**Goal:** sending a follow-up message in a session shows its output live, like the first message
does — no session reopen needed. Final release for all of phases 7–11 is **0.3.2**.

## 0.0 Design recap

- Bug (user report 2026-11-08): after the first exchange in a session, subsequent sends run
  server-side but nothing renders until the session is reopened (which does a fresh full load).
- pi-web is the known-good reference: diff our stream lifecycle against
  `hooks/useAgentSession.ts` before changing anything.

## 1.0 Tasks

### T28 — Reproduce & root-cause *(investigation first)*
- Repro on desktop: open a session, send message 1 (works), send message 2 — observe whether
  `agentRunning` flips, whether SSE events arrive (browser devtools → EventSource frames), and
  whether `store.state.streamingMessage` updates.
- Compare with pi-web against the same server/session (it works there) — diff these paths:
  - pi-web `useAgentSession.ts` ~644–690: per-session `EventSource` to `/api/live/{sid}/events`
    or `/api/agent/{sid}/events`, explicit `es.readyState === EventSource.CLOSED` → re-subscribe.
  - ours: `agent-store.ts` `ensureConnected()` (skips when `sse && sseConnected` — check for a
    **stale `sseConnected`** when the server closes the run-scoped stream without an error event)
    and `connectStream()` / `api/sse.ts` error handling.
  - **runId filtering**: `sendPrompt` does `++this.runId` — verify SSE handlers don't drop run #2
    events on a runId/session-scoped guard.
  - Which stream mode is used per run ("agent" vs "live") and whether run #2 needs a re-subscribe
    pi-web performs and we don't.
- Write the confirmed cause into this file before T29.

**CONFIRMED CAUSE (protocol probe 2026-11-06, `t28-probe.mjs` against pi.halfab.net):**
run #1's terminal frames (`agent_end → agent_settled → prompt_done`) sit undelivered on the
SSE connection (~30s in the capture) and flush exactly when the follow-up's `sendPrompt` has
already set `agentRunning: true` for run #2. The stale `agent_end` passes the `agentRunning`
guard → `finishRun()` (wipes `streamingMessage`, flips `agentRunning` false) → every run #2
frame after that (streaming, the reply's `message_end`, its real `agent_end`) is dropped by the
late-event guards, and `refreshFromDisk` never runs → nothing renders until reopen. First
messages are unaffected (no predecessor's stale frames). pi-web is immune because its
`ensureEventsConnected` → `connectEvents` **closes and re-subscribes the EventSource on every
send** — stale buffers die with the old connection (a fresh subscribe delivers only `connected`
+ live frames — verified in the probe) — plus `finishPromptWithoutStream` loads the session
*before* marking the run finished and carries a runId staleness check.
Repro artifact: `/tmp/pi/notes/pi-obsidian-0.3.2/t28-probe.mjs` + `t28-probe.log`.

### T29 — Fix stream lifecycle to pi-web parity
- **Fix (implemented):** fresh subscription at every prompt send — `ensureConnected` now
  reconnects unconditionally (pi-web `connectEvents` semantics) instead of trusting a possibly
  stale `sseConnected` flag; the run-start boundary drops the previous run's undelivered
  terminal frames. Terminal-handler ordering (load-then-finish) was evaluated and left as-is:
  once stale frames can't arrive, both orderings are benign, and ours matches the
  late-event-guard comments.
- Verify: two follow-ups in one session stream live; kill/restart the server mid-session and
  confirm the reconnect path still works (existing `reconnectTimer` behavior must not regress);
  headless harness still passes (`npm run check`).

## 2.0 Verification

- Desktop + phone: three-message session, all output appears live with no reopen.
- No regression to first-message streaming or reconnect-after-server-restart.
