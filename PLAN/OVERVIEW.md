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

*(2026-11-04 revision — supersedes the Phase-1 layout/placement decisions.)*

- **Layout**: session bar on top (title → opens pi panel, status, version), transcript in the
  middle (virtualized scroll region), **prompt editor at BOTTOM** with the primary button row
  under it. Composer floats above the iOS keyboard via Obsidian's `--keyboard-height`.
- **Button row** (left→right): attach (paperclip), include/hide open files (file icon + count
  badge), model chip (cpu icon + name → menu) … right side: **idle** = one circular send button
  (arrow-up, interactive-accent, disabled when empty); **running** = Stop pill (red) + Queue
  button (yellow when text present) which sends **steer**. Follow-up/queue-after-run UI is
  deliberately dropped — not a pi-harness concept.
- **Right sidebar = pi panel** (a dedicated view; the "Open pi in" setting is retired, chat is
  main-area only): session picker (Recent | Folders), control buttons (new session, thinking
  pill-selector, compact), settings-shortcut buttons (Models wired first; Skills/Plugins parked).
  Layout mirrors Obsidian's sidebar conventions: mobile = settings top / list / toggle /
  controls bottom; desktop = controls top / toggle / list / settings bottom.
- **Session picker**: Recent = global recency. Folders = SERVER file tree (never the vault —
  drift must not seed bogus cwds), Obsidian-explorer styling, pinned `[ New session ]` first in
  every dir + per-dir recency below it.
- **New-session cwd chain**: "Default Session Path" setting → current session's cwd → last
  created session's cwd → `pathPrefix` (the vault-mapping setting, reused as configured root;
  `~` expanded via `GET /api/home` — never send `~` to existsSync-checked endpoints).
- **Settings tab**: base URL, path prefix, default session path; Models section (minimal port:
  default model + model list; provider auth stays in the pi-web site for now).
- **Open-file mentions**: ALL open file tabs, deduped, mapped vault path → server path via the
  configurable prefix (`~/HalfaCloud/Jumperpedia`), injected at prompt send per pi-web doc 1.41.
- **Rendering**: Obsidian `MarkdownRenderer` for prose (theme-native); custom themed components
  for tool-call runs (live → condense per pi-web semantics), thinking toggles, diffs. Obsidian
  CSS variables only.
- **Secondary actions** are commands, surfaced via the ribbon-menu button.
- **Dropped**: completion sound; per-session tools toggle; follow-up queue; sidebar placement.
- **Transport**: `fetch` streaming (`response.body.getReader()`) for SSE, plain `fetch` for
  one-shots. `EventSource` rejected (no custom headers — blocks auth later).

## 4.0 Phases

- [x] **Phase 0 — Spike & dev loop** (`PHASES/PHASE-0.md`): scaffold, pi-web CORS change, minimal
      live-streaming spike view; validate the dev loop. (Phone rows 6–10 deferred to later exit.)
- [x] **Phase 1 — Core chat** (`PHASES/PHASE-1.md`): state store port, chat view, renderers,
      picker/modals, commands, keyboard inset. (Virtualization deferred to phone perf pass.)
- [x] **Phase 2 — Layout & Composer** (`PHASES/PHASE-2.md`): bottom composer, auto-grow editor,
      button-row states (send/stop/queue/attach/include/model), placement removal.
- [x] **Phase 3 — Right panel** (`PHASES/PHASE-3.md`): pi-panel view, pill-selector, Recent
      session list, control + settings buttons, Models settings section.
- [x] **Phase 4 — Folders picker & session paths** (`PHASES/PHASE-4.md`): server tree, per-dir
      new-session pins, Default Session Path + cwd fallback chain.
- [x] **Phase 5 — Transcript fidelity & composer features** (`PHASES/PHASE-5.md`): pi-web
      condense semantics, attachments, open-file mentions; closes the deferred phone rows.
- [x] **Phase 7 (A) — Follow-up output bug** *(PHASE-7.md)*: follow-up sends show output live
      (SSE lifecycle parity with pi-web's hook; investigate-first).
- [x] **Phase 8 (B) — Quick wins** *(PHASE-8.md)*: working indicator (bouncing line on the
      composer separator), sessions open at bottom, context-size display bug (real — investigate),
      model chip shows default, default thinking setting, panel thinking pill removed.
- [x] **Phase 9 (C) — Message actions** *(PHASE-9.md)*: copy / edit-from-here / fork wired from
      the already-ported pi-web machinery; hover on desktop, tap-to-reveal on mobile.
- [x] **Phase 10 (D) — Bottom-bar takeover** *(PHASE-10.md)*: composer covers the mobile nav
      when closed (controls lower, background to the screen edge), tab button joins the button
      row (tap=overview, long-press=menu), mentions toggle moves to the panel (both layouts).
- [x] **Phase 12 — Composer Enter key** *(PHASE-12.md)*: mobile return = newline (send button
      sends), desktop keeps Enter-send / Shift-Enter-newline.
- [x] **Phase 13 — Multi-instance machines** *(PHASE-13.md)*: named pi-web instances in
      settings, per-tab machine binding (persisted), panel machine pill, per-machine session
      lists, last-used machine for new tabs. **Ship as 0.4.0.**
- [ ] **Phase 14 — Voice mode** *(PHASE-14.md)*: hands-free overlay on the current session
      (pi-voice-chat port): gestures + glow, faster-whisper STT + piper TTS via new
      `stt.halfab.net` / `piper.halfab.net` contracts, read-mode-style invisible mode banners.
      **Ship as 0.5.0.**
- [x] **Phase 11 (E) — Multiple pi tabs** *(PHASE-11.md)*: N sessions in N tabs/splits with an
      active-view concept; new "Open pi in new tab" command. **Ship everything as 0.3.2.**
- [~] **Phase 6 — Hardening & distribution** (2026-11-04/05): phone-validated via BRAT
      releases (github.com/ejumper/pi-obsidian, LiveSync plugin-sync excluded by design —
      phone = production, desktop = dev); keyboard saga resolved (screen-anchored composer);
      debug tooling retired; headless harness (test/) shipped; changelog + docs wrapped.
      Perf: no virtualization needed at current session sizes — revisit if long sessions
      stutter on iOS.

## 5.0 Working Agreement

1. Plans live here (`PLAN/`), scratch notes in the session scratchpad.
2. Architect (main model) makes design decisions, writes load-bearing skeletons, reviews all work.
3. Executor sub-agent builds well-specified modules; every task ships with a verification step.
4. Loop: plan → delegate with spec → architect builds/reviews → user spot-checks in
   emulated-mobile desktop hot-reload → next task.
5. Dev loop (validated in Phase 0): `npm run dev` (esbuild watch → vault plugin dir) + Hot Reload
   plugin; `this.app.emulateMobile(true)` for the mobile shell on desktop; LiveSync carries the
   plugin folder to the phone; Logstravaganza ships phone console logs back to the vault.
