# Phase 5 — Transcript Fidelity & Composer Features

**Goal:** the transcript behaves like pi-web's (tool runs live → condense when prose flows), and
the two parked composer buttons become real: attachments and open-file mentions.

## 0.0 Design recap

- **Transcript**: match pi-web's `MessageView`/`ChatWindow` presentation semantics — tool calls
  print live while the run executes, then condense into a single openable summary row (tool
  names + chevron) once assistant prose follows, with the message rendered below. Thinking
  blocks stay collapsed. This is a port of presentation decisions, restyled theme-native.
- **Attachments** (paperclip): OS file picker (`<input type="file" multiple>` — works in the
  iOS webview via the Files app). Images → base64 into the prompt's `images` (the store's
  `AttachedImageInput` is already typed) with a preview chip strip above the editor (X to
  remove). Non-image files → `POST /api/attachments` (multipart → server `/tmp` path) and the
  reference format pi-web uses in the message. Surface size/upload errors (nginx 413 history).
- **Mentions** (include/hide): toggle persists in plugin settings. At send, when enabled:
  enumerate all file tabs in the workspace (dedupe), map vault path → server path
  (`pathPrefix` + vault-relative, `~`-literal display), and inject pi-web's mention syntax into
  the outgoing message (format per Pi-Web doc 1.41). Badge count = files that would be injected.

## 1.0 Tasks

### T24 — Condense semantics *(architect + executor)*
- Study pi-web `components/MessageView.tsx` + `components/ChatWindow.tsx` grouping logic.
- Rework `src/views/render/`: consecutive tool-call/tool-result messages group into a collapsible
  "run" row (live-expanded while streaming the run; condenses when a prose message arrives).
  Entry-level collapse state, chevron, tool-name summary line.
- **Verify:** build + visual A/B against the pi-web site on the same session.

### T25 — Attachments *(executor, background)*
- `src/views/composer/attachments.ts`: file picker plumbing, image preview chips (object URLs,
  revoked on remove), image → base64 blocks for `images`, non-image → `POST /api/attachments`
  via the client (multipart), message reference format ported from pi-web `ChatInput.tsx`.
- Wire to the paperclip button (enable it); store already accepts `images` on prompt/steer.
- **Verify:** typecheck/build + manual send with image + text file on desktop and phone.

### T26 — Mentions *(executor, background)*
- `src/views/composer/mentions.ts`: workspace tab enumeration (the Phase-0 probe solidified),
  path mapping, count badge on the toggle button, injection into the message text at send time
  per doc 1.41's syntax. Toggle state persisted in settings.
- **Verify:** typecheck/build + manual: open 3 notes, enable, send, confirm the agent receives
  the 3 mentions with server-side paths.

## 2.0 Exit criteria

- Transcript A/B with pi-web shows equivalent information density and behavior.
- Attachments and mentions work end-to-end on the phone (matrix rows 6–11 ride along).
- Phase-0 matrix rows 4–11 fully closed on the polished UI.

## 3.0 Risks

- Doc 1.41's mention syntax may assume cwd-relative behavior — read the doc + pi-web's
  implementation before wiring; wrong format silently degrades the prompt.
- Attachment size limits on the Tailscale/nginx path — chunk or warn before the server rejects.
