# Phase 9 (group C) — Message Actions

**Goal:** per-message actions like pi-web: copy, "edit from here" (message into the composer,
session rewinds on send), and "new session" (fork from that entry). Desktop = hover, mobile =
tap to reveal. Rendered exactly like pi-web: small text, right below the relevant message.

## 0.0 Design recap

- The verbatim port already ships pi-web's action machinery: `MessageView.tsx` has
  `copyContent`, `onEditContent`, `onFork`, `forking`, `entryId` plumbing and the action-row
  rendering — it is inert because `src/views/react/Transcript.tsx` passes no callbacks
  (`canFork = !!entryId && !!onFork` gates the UI). This phase is wiring + touch translation,
  not new UI.
- Semantics (verify exact behavior in pi-web's hook during T36):
  - "edit from here" = load the message content into the composer; on send the session is
    rewound to that entry first (pi-web's `onEditContent` flow).
  - "new session" = fork: a new session containing history up to that entry (pi-web's fork API,
    likely under `app/api/sessions/[id]` — confirm endpoint + payload).
  - copy = message text to clipboard (pi-web's `lib/clipboard` helper is already ported —
    verify it works in the WKWebView; fall back to `navigator.clipboard.writeText`).
- Mobile touch translation (decision 2026-11-08): tap the message body toggles the action row
  (same place hover reveals it on desktop); tap elsewhere dismisses. Taps on links, code blocks,
  read-aloud buttons etc. must NOT trigger reveal. Long-press is the documented fallback if
  tap-to-reveal feels ambiguous in use.

## 1.0 Tasks

### T36 — Wire the pi-web callbacks *(store/API first, UI second)*
- In `Transcript.tsx`'s MessageView glue pass `onFork`, `onEditContent`, `entryId`, `forking`.
- Store/API support:
  - fork → pi-web's fork endpoint (confirm at implementation; likely creates a session and
    returns its id) then open the forked session in the view (Phase 11 will make this
    "in the active tab" — until then, the only tab).
  - edit-from-here → load text into composer; on next send, issue pi-web's rewind/truncate
    before the prompt (find the exact pi-web call in `useAgentSession`'s edit flow and mirror
    it — do not invent session surgery).
  - copy → ported clipboard helper; confirm in iOS webview.
- Keep the port verbatim rule: no edits inside `src/views/react/pi-web/` except commented
  divergence lines.

### T37 — Touch/hover presentation parity
- Hover reveal on desktop (pi-web's own CSS does this — verify against our compat layer and
  only add what the layer misses).
- Mobile: tap-to-reveal state per message (React state in the glue layer, not in the verbatim
  subtree); reveal placement/style = pi-web's exact look (small text row under the message).
- Any theme-variable mappings the action row needs go in the CSS compat block (variable-name
  comment, like the existing 10).

## 2.0 Verification

- Desktop: hover any message → pi-web-identical action row; copy works; edit-from-here loads
  the composer and send rewinds; fork opens the new session with prior history.
- Phone: tap reveals, tap-away dismisses, links/code/read-aloud unaffected; same three actions
  work end to end.
- `npm run check` green; verbatim-subtree diff against pi-web shows only commented divergences.
