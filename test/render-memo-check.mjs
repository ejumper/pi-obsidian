// 0.5.29 regression check — the PHASE-20 render identity contract (heat pass).
// MessageView is React.memo'd; the memo only skips work when its props are
// reference-stable. These assertions pin the two contracts that stability
// rests on:
//   1. stripMessageVoiceBlocks is identity-preserving (returns THE message
//      object when no <voice-mode> block is present);
//   2. createUnitsCache returns the SAME units array (and the same nested
//      member/toolResults references) while its inputs are reference-equal,
//      and recomputes exactly when they change.
// With these + stable handler identities, a stream delta re-renders one
// message (the tail) instead of the whole session.
//
// Usage: npm run check                    (builds first)
//        node test/render-memo-check.mjs  (uses existing dist/main.js)

import { createRequire, Module } from "node:module";

const stub = await import("./obsidian-stub.mjs");
const origLoad = Module._load;
Module._load = (id, parent, isMain) => (id === "obsidian" ? stub : origLoad(id, parent, isMain));
const require = createRequire(import.meta.url);
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const eq = (got, want, label) =>
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${label} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );

const bundle = require("../dist/main.js");
const { stripMessageVoiceBlocks, createUnitsCache } = bundle;

const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (blocks, extra = {}) => ({ role: "assistant", content: blocks, model: "m", provider: "p", ...extra });
const text = (t) => ({ type: "text", text: t });
const call = (id, name) => ({ type: "toolCall", toolCallId: id, toolName: name, input: {} });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });

// 1 — strip identity: no banner in, same object out
{
  const m = user("hello");
  ok(stripMessageVoiceBlocks(m) === m, "strip preserves identity when no voice banner");
  const banner = user("<voice-mode>x</voice-mode>\n\nhello");
  const stripped = stripMessageVoiceBlocks(banner);
  ok(stripped !== banner && !JSON.stringify(stripped).includes("voice-mode"), "strip rewrites banner messages");
}

// 2 — cache identity: same inputs, same units (deep references included)
const messages = [
  user("run it"),
  asst([call("t1", "bash")]),
  result("t1"),
  asst([text("done")]),
];
const entryIds = ["e0", "e1", "e2", "e3"];
const unitsFor = createUnitsCache();
{
  const a = unitsFor(messages, true, entryIds, null);
  const b = unitsFor(messages, true, entryIds, null);
  ok(a === b, "same inputs return the SAME units array");
  const gA = a.find((u) => u.kind === "group") ?? a[0];
  const gB = b.find((u) => u.kind === "group") ?? b[0];
  ok(gA === gB, "unit wrappers are identical (memo can skip)");
  if (gA.kind === "group" && gB.kind === "group") {
    ok(gA.toolResults === gB.toolResults, "toolResults map identity is stable");
    ok(
      gA.members.every((m, i) => m.message === gB.members[i].message),
      "member message objects are stable",
    );
  }
  ok(gA.message === gB.message, "unit message object is stable");
}

// 3 — any changed input recomputes
{
  const a = unitsFor(messages, true, entryIds, null);
  const b = unitsFor([...messages, asst([text("more")])], true, [...entryIds, "e4"], null);
  ok(a !== b, "changed messages recompute the units");
  ok(b.length > 0, "recomputed units are real");
  const c = unitsFor(messages, false, entryIds, null);
  ok(a !== c, "running flag change recomputes");
}

// 4 — the compaction-estimate twist is part of the key
{
  const comp = [
    user("hi"),
    asst([text("ok")]),
    { role: "custom", customType: "compaction", content: [{ type: "text", text: "Session compacted" }], details: { tokensBefore: 10 } },
  ];
  const ids = ["u", "a", "c"];
  const r1 = { tokensBefore: 10, estimatedTokensAfter: 5, tokensCompacted: 5 };
  const a = unitsFor(comp, false, ids, r1);
  const b = unitsFor(comp, false, ids, r1);
  ok(a === b, "same compactResult keeps identity");
  const tailA = a[a.length - 1];
  const c = unitsFor(comp, false, ids, { ...r1 });
  ok(a !== c, "new compactResult object recomputes (fresh estimate)");
  const tailC = c[c.length - 1];
  ok(tailA !== tailC, "the tail compaction message is re-stamped");
  ok(
    tailC.message.details?.estimatedTokensAfter === 5,
    "the fresh estimate rides the tail message",
  );
}

// 5 — the compaction completion caret renders at the SEAM (0.5.33: it was a
// bottom-pinned banner that stayed below every new message).
{
  const msgs = [user("a"), asst([text("b")]), user("c"), asst([text("d")])];
  const ids = ["e0", "e1", "e2", "e3"];
  const r = { tokensBefore: 10, estimatedTokensAfter: 5 };
  const mid = unitsFor(msgs, false, ids, r, 2);
  const kinds = mid.map((u) => u.kind);
  eq(kinds.indexOf("caret"), 2, "caret sits at the seam between the turns");
  const c1 = mid[kinds.indexOf("caret")];
  eq(
    { t: c1.tokensBefore, e: c1.estimatedTokensAfter },
    { t: 10, e: 5 },
    "caret carries the live numbers",
  );
  const atEnd = unitsFor(msgs, false, ids, r, 4);
  eq(atEnd.map((u) => u.kind).indexOf("caret"), atEnd.length - 1, "seam at the end: caret last (no new messages yet)");
  const noCaret = unitsFor(msgs, false, ids, null, 2);
  ok(!noCaret.some((u) => u.kind === "caret"), "no compaction result: no caret");
  const idA = unitsFor(msgs, false, ids, r, 2);
  const idB = unitsFor(msgs, false, ids, r, 2);
  ok(idA === idB, "same caret spec keeps cache identity");
  const moved = unitsFor(msgs, false, ids, r, 3);
  ok(moved !== idA, "a moved seam recomputes the units");
}

console.log(failures === 0 ? "render-memo-check: all green" : `render-memo-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
