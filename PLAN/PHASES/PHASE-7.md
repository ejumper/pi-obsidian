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

### T29 — Fix stream lifecycle to pi-web parity
- Implement the fix per T28's finding; the bar is "identical observable behavior to pi-web's
  hook on the same session".
- Verify: two follow-ups in one session stream live; kill/restart the server mid-session and
  confirm the reconnect path still works (existing `reconnectTimer` behavior must not regress);
  headless harness still passes (`npm run check`).

## 2.0 Verification

- Desktop + phone: three-message session, all output appears live with no reopen.
- No regression to first-message streaming or reconnect-after-server-restart.
