# Phase 0 — Spike & Dev Loop

**Goal:** kill every make-or-break unknown before committing to the full build, and stand up the
development loop the rest of the project runs on.

**Unknowns this phase must retire:**
1. Can the Obsidian webview (desktop *and* iOS) do CORS `fetch` + SSE streaming against the pi-web
   site? (→ drives the CORS change + transport choice)
2. Does the plugin-folder delivery loop to the iPhone actually work (LiveSync → enable/reload)?
3. Does the dev loop feel right (esbuild watch + Hot Reload + `emulateMobile(true)`)?
4. Can we get phone console logs back without a Mac (Logstravaganza round-trip)?

## 1.0 Deliverables

- **A. Repo scaffold** (this repo): build system, manifest, conventions. *(architect)*
- **B. pi-web CORS change** (pi-web codebase): `/api/*` serves CORS headers. *(executor)*
- **C. Spike plugin**: settings (base URL) → session list → open one session → live SSE transcript
   (plain text) → send a prompt and watch it stream. Main-area view only. *(executor, architect wires)*

Explicitly **out of scope** for Phase 0: nice rendering, session picker modal, placement setting,
reconnect/reconciliation logic, mentions, attachments, virtualization, keyboard handling.

## 2.0 Protocol surface used by the spike

(From the pi-web recon; exact JSON shapes confirmed against `lib/types.ts` and the route handlers
during T2. Base = setting value, e.g. `https://pi-desktop.halfab.net` or `http://localhost:30141`.)

| Call | Purpose | Notes |
|---|---|---|
| `GET /api/sessions` | session list | shape per `app/api/sessions/route.ts` |
| `GET /api/sessions/:id` | history | reads the `.jsonl`; entries carry `message` + `entryId` |
| `POST /api/agent/new` `{cwd, type:"prompt", message}` | start a session + first prompt | returns pi's real `sessionId` |
| `POST /api/agent/:id` `{type:"prompt"\|"abort", ...}` | command envelope | response `{success:true,data}` \| `{error}` |
| `GET /api/agent/:id/events` | **SSE stream** | unnamed `data: <json>` frames; `:\n\n` heartbeats every 30s |
| `GET /api/agent/:id` | `{running, state}` snapshot | spike uses on reconnect only |

SSE frames the spike must handle: `connected`, `message_start`, `message_update` (cumulative
snapshot — replace, don't append), `message_end`, `tool_execution_start/end`, `agent_start/end`,
`prompt_done`, `prompt_error`. Everything else: log and ignore.

Transport decision: `fetch` + `response.body.getReader()` streaming parser (handles both unnamed
`data:` and named `event:` framing). No `EventSource` (can't send headers; auth will need them).

## 3.0 Tasks

### T0 — Scaffold *(architect; conventions are load-bearing)*
- `manifest.json` (id `pi-obsidian`, `isDesktopOnly: false`, minAppVersion 1.15), `package.json`,
  `tsconfig.json`, `esbuild.config.mjs` (watch mode; bundles `src/main.ts` →
  `~/HalfaCloud/Jumperpedia/.obsidian/plugins/pi-obsidian/main.js`, copies `manifest.json` +
  `styles.css`, drops a `.hotreload` marker), `.gitignore`, `git init`.
- Layout conventions: `src/api/` (transport), `src/state/` (store), `src/views/` (UI),
  `src/settings.ts`, `main.ts` (plugin entry).
- **Verify:** `npm run build` produces the three files in the vault plugin dir; plugin loads in
  desktop Obsidian (shows up in Community plugins → Installed).

### T1 — pi-web CORS *(executor)*
- In the pi-web codebase `next.config.ts`: `headers()` adds to `/api/*` —
  `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS`,
  `Access-Control-Allow-Headers: Content-Type, Authorization`, and 204 responses to `OPTIONS`.
  (No cookies in this API, so `*` is safe; token auth, if ever added, goes in a header.)
- **Verify (architect):** `curl -i -X OPTIONS -H "Origin: app://obsidian.md" .../api/sessions` returns
  the headers + 204; `npm run build && systemctl --user restart pi-web.service` on the desktop;
  plain GET from the webview works. (pi-web container deploy NOT needed until the phone uses the
  server instance — deferred to Phase 3.)

### T2 — Transport modules *(executor)*
- `src/api/client.ts`: typed one-shot helpers (sessions list/history, agent new/prompt/abort,
  agent state) with the `{success,data}|{error}` envelope handling.
- `src/api/sse.ts`: streaming SSE reader over `fetch` — chunk-safe frame parsing (any chunk
  boundary, CRLF/CR, multi-line `data:`, comments/heartbeats, named events), typed event union for
  the spike frames, `close()` support.
- **Verify:** `tsc --noEmit` + build pass; architect reviews the parser against the framing rules
  in §2.0.

### T3 — Spike view *(executor builds to spec, architect wires state)*
- `src/settings.ts`: PluginSettingTab with `baseUrl` (default `http://localhost:30141`) and
  `pathPrefix` (default `~/HalfaCloud/Jumperpedia`, unused in spike but shipped now).
- `src/views/SpikeView.ts` (ItemView): left column = session list (click to open); right/main =
  transcript rendered as plain text (role + text blocks, cumulative `message_update` replaces the
  live message, `tool_execution_*` shown as one-line stubs); bottom = bare textarea + Send +
  Abort.
- Command "pi: Open spike view" + ribbon icon.
- **Verify:** build passes; architect review; then the user smoke test below.

### T4 — Validation run *(architect + user)*
Walk the matrix in §4.0 on desktop and phone; results recorded here.

## 4.0 Validation matrix

| # | Check | Where | Pass criteria | Result |
|---|---|---|---|---|
| 1 | CORS `fetch` against pi-web site | desktop webview | session list populates | ✅ 2026-11-04 |
| 2 | SSE streaming | desktop webview | live tokens appear while pi runs | ✅ 2026-11-04 |
| 3 | Prompt round-trip | desktop webview | prompt → stream → `prompt_done` | ✅ 2026-11-04 |
| 4 | `emulateMobile(true)` loop | desktop | UI usable in mobile shell; toggle back clean | [ ] (folded into Phase 1 checks) |
| 5 | Hot Reload pickup | desktop | edit → reload with no manual step | [ ] (user enabled plugin; confirm on next edit) |
| 6 | Plugin folder delivery | iPhone via LiveSync | build appears in `.obsidian/plugins/pi-obsidian/` on phone | deferred → Phase 1 exit |
| 7 | Plugin runs on iOS | iPhone | spike view opens, list loads | deferred → Phase 1 exit |
| 8 | CORS + SSE on iOS webview | iPhone | live stream renders | deferred → Phase 1 exit |
| 9 | Phone reload path | iPhone | either mobile Hot Reload works, or off/on toggle is tolerable | deferred → Phase 1 exit |
| 10 | Logstravaganza round-trip | phone → desktop | a `console.log` from the plugin lands in the vault note | deferred → Phase 1 exit |
| 11 | Workspace tab enumeration probe | desktop + emulated | `app.workspace` leaves → file paths logged (mentions groundwork) | [ ] (command shipped: "pi: Debug: log open tabs") |

Fallbacks if the loop fails: #6/#9 → BRAT + GitHub releases (documented, slower); #8 → check
`https://pi-desktop.halfab.net` in mobile Safari first (isolates webview vs network).

## 5.0 Definition of Done

Matrix rows 1–11 checked (or a fallback adopted and noted), spike source lives in this repo,
and we have a go/no-go note on each Phase 1 assumption (LiveSync delivery reliability being the
big one). Then `PLAN/OVERVIEW.md` phase list gets Phase 0 checked off and Phase 1 planning starts.

**Status 2026-11-04:** rows 1–3 ✅ (user smoke test: list loads, sessions open, prompt streams).
Rows 6–10 deferred by user decision — phone push waits until the UI is polished; they run as
Phase 1 exit criteria instead. Rows 4/5/11 fold into Phase 1 checks. Phase 0 functionally closed.

## 6.0 Assumptions & risks

- **Vault root = `~/HalfaCloud/Jumperpedia`** — confirmed (`.obsidian/plugins/` present). Build
  targets `~/HalfaCloud/Jumperpedia/.obsidian/plugins/pi-obsidian/`.
- **Hot Reload (pjeby) is not installed** in the vault yet — manual install into
  `.obsidian/plugins/hot-reload/` (not in the community store). User task before T0 verification.
- **Repo is inside the LiveSynced tree**, so the phone also receives the repo source — harmless,
  but note the install folder (`.obsidian/plugins/`) is what the app loads.
- **LiveSync plugin-folder sync may be flaky** (Mar 2026 forum reports) — that's exactly what
  matrix rows 6/9 measure.
- **pi-web desktop instance must be running** for spike testing (`pi-web.service`).
