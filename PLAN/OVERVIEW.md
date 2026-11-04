# pi-obsidian — Plan Overview

An Obsidian plugin (desktop + iOS) that replaces the pi-web PWA as the GUI for the pi agent
harness. The harness and pi-web server side stay where they are; this plugin is a new front-end
speaking the pi-web site's existing HTTP+SSE API over Tailscale.

## 1.0 Terminology

| Term | Means |
|---|---|
| pi install | the `@earendil-works/pi-coding-agent` harness running in-process inside a pi-web instance |
| pi-web container | the Docker container on the server at `/opt/pi-web` |
| pi-web site | the web page/API the pi-web codebase serves (desktop systemd service OR pi-web container) |
| pi-web codebase | `~/HalfaCloud/Jumperpedia/Projects/Repos/pi-web` (builds both instances) |
| the plugin | pi-obsidian — this repo |
| vault | the Jumperpedia vault at `~/HalfaCloud/Jumperpedia` (LiveSynced to the phone) |

## 2.0 Architecture

```
┌─ Obsidian plugin (this repo) ────┐        ┌─ pi-web site ──────────────────┐
│ views (Obsidian-native UI)       │  HTTP  │ routes + rpc-manager (unchanged)│
│ state store (ported protocol     │◄──────►│                                │
│   logic from hooks/useAgentSession) │ + SSE│  → pi install (in-process)     │
└──────────────────────────────────┘        └────────────────────────────────┘
```

- The plugin never touches the pi install. It speaks the pi-web site's JSON+SSE API
  (endpoints/protocol map: `PHASES/PHASE-0.md` §2 and the pi-web recon report).
- One-time pi-web codebase change required: CORS headers on `/api/*` (the Obsidian webview is a
  different origin). No other server changes.
- Two instances, selected by a base-URL setting (default: desktop; server optional).

## 3.0 Design Decisions

- **Placement**: setting switches the view between the main area (tab) and the right sidebar.
  Same UI code, responsive to container width.
- **Layout**: prompt editor at TOP of the view, primary button row under it (file attacher, model
  selector, open-file include/hide, send), transcript streaming below. Composer stays clear of the
  iOS keyboard via Obsidian's `--keyboard-height` CSS variable.
- **Settings tab**: models/skills/plugins/tools defaults, base URL(s), vault-root→server path
  prefix (for mentions), instance selection.
- **Secondary actions** (thinking level, compact, new session, session picker opener) are commands,
  surfaced via the ribbon-menu button. Primary actions live in the composer row.
- **Rendering**: Obsidian `MarkdownRenderer` for all prose (theme-native, wiki-links for free);
  custom themed components only for tool-call cards, diffs, thinking toggles, extension terminal
  frames. No Tailwind skin — Obsidian CSS variables only.
- **Session picker**: `SuggestModal` (Obsidian's native fuzzy switcher). Session title in the view
  header where the file name sits.
- **Open-file mentions**: enumerate files open in workspace tabs, map vault path → server path via
  a configurable prefix (`~/HalfaCloud/Jumperpedia`). Mention fires at prompt send.
- **Dropped**: completion sound (pi-web invention, unwanted). Per-session tools toggle (defaults in
  plugin settings only).
- **Transport**: `fetch` streaming (`response.body.getReader()`) for SSE, plain `fetch`/`requestUrl`
  for one-shots. `EventSource` rejected (no custom headers — blocks auth later).

## 4.0 Phases

- [x] **Phase 0 — Spike & dev loop** (`PHASES/PHASE-0.md`): scaffold, pi-web CORS change, minimal
      live-streaming spike view; validate the whole dev loop including the phone. (Phone rows
      6–10 deferred to Phase 1 exit by user decision.)
- [ ] **Phase 1 — Core chat**: state store port, chat view (transcript, tool cards, thinking,
      composer), model/thinking popover, session picker, commands + ribbon, settings tab,
      reconnect/reconciliation, placement setting, virtualization + keyboard handling.
- [ ] **Phase 2 — Subsystems**: open-file mentions, file attachments; optional tier: live terminal
      view (pi-live), voice.
- [ ] **Phase 3 — Hardening & distribution**: iOS perf pass on device, BRAT/release pipeline,
      Guides documentation (approval required), changelog wrap-up.

## 5.0 Working Agreement

1. Plans live here (`PLAN/`), scratch notes in the session scratchpad.
2. Architect (main model) makes design decisions, writes load-bearing skeletons, reviews all work.
3. Executor sub-agent builds well-specified modules; every task ships with a verification step.
4. Loop: plan → delegate with spec → architect builds/reviews → user spot-checks in
   emulated-mobile desktop hot-reload → next task.
5. Dev loop (validated in Phase 0): `npm run dev` (esbuild watch → vault plugin dir) + Hot Reload
   plugin; `this.app.emulateMobile(true)` for the mobile shell on desktop; LiveSync carries the
   plugin folder to the phone; Logstravaganza ships phone console logs back to the vault.
