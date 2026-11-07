# Phase 8 (group B) — Quick Wins

**Goal:** five small improvements + the "working" indicator: ambient run-alive signal, sessions
open at the bottom, the context-size display actually working, sensible model-chip text, default
thinking level in settings, and the panel's duplicate thinking selector removed.

## 0.0 Design recap (decisions locked with user 2026-11-08)

- **Working indicator** = pi TUI's "working" notification translated to the GUI: a thin line on
  the separator between transcript and composer (the composer's top edge) that bounces back and
  forth while `agentRunning` (whole run — thinking, tool calls, and streaming), not just while
  streaming. Respect `prefers-reduced-motion` (static pulse fallback). Show on desktop too.
- **Open at bottom** is purely session-open/switch behavior — streaming auto-scroll untouched.
- **Context size bug is real** (user evidence: the same build removed the version stamp from the
  bar — it was on the phone — but the size never rendered). Investigate before fixing.
- **Model chip**: show the configured default model's name when no per-session override exists;
  the literal word "model" only when nothing is configured.
- **Default thinking level** is set in settings and seeds the composer's model/thinking picker —
  exactly like the model default. Choosing a different level happens in that picker (per-session
  override). This supersedes any "default wins on open" semantics.
- **Panel thinking pill is deleted** (the picker in the composer is the single source).

## 1.0 Tasks

### T30 — Working indicator (bouncing line)
- 2–3px accent-colored (`--interactive-accent`) line on the composer's top border; CSS
  keyframes slide/bounce it horizontally; visibility = `store.state.agentRunning`.
- `prefers-reduced-motion: reduce` → static glowing segment instead of motion.
- It must not shift layout (absolute/overlay on the border, not a flex child).

### T31 — Sessions open at the bottom
- On session load/switch (store session-loaded path / ChatView render after load), scroll the
  transcript container to the end. Cover: open from SessionPickerModal, ServerTree, panel list,
  and view reopen.

### T32 — Context-size display *(investigate first)*
- The bar element exists (`barSizeEl`, `renderContextSize` in ChatView) and self-hides when
  `state.contextUsage` is null — so either the data never arrives or the render path is broken.
- Compare state paths: pi-web `useAgentSession.ts` merges `contextUsage` from four sources
  (SSE `state` live ~493, REST state fetch ~887, `d.state` ~948, `agentState.state` ~1704).
  Ours merges only in `applyRuntimeState` (called from ~327 SSE handler and ~1024 REST fetch) —
  find which pi-web source is missing or mis-shaped in ours (check `AgentRuntimeState` typing in
  `src/api/types.ts` and the exact SSE event field path).
- Also verify the **deployed pi-web emits the field at all** (server container version vs the
  pi-web commits that added `contextUsage` — `0e809e4`, `fadd05e`): a session's raw `state`
  frames in devtools settle it in one look.
- Fix per finding; verify live that `12k/200k | 6%` renders and updates after sends.

### T33 — Model chip shows the configured default
- `modelChipNameEl`: `currentModel?.modelId ?? settings.defaultModel ?? "model"` (exact source
  of "configured default" per how send() picks its model — reuse that resolution, don't invent
  a second one).

### T34 — Default thinking level setting
- Plugin setting "Default thinking level" (values = the picker's set), persisted in settings;
  seeds `thinkingLevel` when a session has no stored override. Picker override persists in
  session state (pi-web parity). Send-time behavior unchanged.

### T35 — Remove the panel thinking pill
- Delete the thinking PillSelect from PanelView's Controls row (state stays in the store; only
  the control goes). The freed row slot is reused in Phase 10 T40.

## 2.0 Verification

- Indicator bounces during thinking/tool phases and streaming, never when idle; static variant
  under reduced-motion.
- Every session-open path lands at the bottom.
- Context size visible and accurate on phone + desktop against both server instances.
- Chip reads the default model name before any override.
- New setting seeds the picker; panel has no thinking control.
