# Phase 12 — Composer Enter Key

**Goal:** on mobile the keyboard's enter key inserts a newline (the send button is the only way
to send); on desktop Enter sends and Shift+Enter stays newline. *(0.4.0, with Phase 13.)*

## 0.0 Design recap (decisions locked 2026-11-07)

- Platform split is clean and preferred over any fallback: `Platform.isMobile` gates the
  keydown behavior. Hardware-keyboard-on-iPad edge case accepted by the user.
- Set `enterkeyhint="enter"` on the textarea so iOS renders "return", not "go".

## 1.0 Tasks

### T44 — Enter behavior + enterkeyhint
- ChatView's textarea keydown handler: mobile → do NOT intercept Enter (textarea inserts the
  newline natively); desktop → Enter sends (existing behavior), Shift+Enter newline (existing).
- textarea: `setAttribute("enterkeyhint", "enter")` at creation.
- Verify: typecheck/build/harness green; behavior check list below.

## 2.0 Verification

- Phone: return key inserts a newline; send button sends; Shift+Enter irrelevant (no shift key).
- Desktop: Enter sends, Shift+Enter newline (unchanged).
