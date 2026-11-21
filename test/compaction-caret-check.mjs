// 0.5.17 regression check — compaction caret rendering through the REAL React
// layer (the seam no other harness can reach: react-dom's createRoot needs a
// real DOM, so this one runs against jsdom). Renders TranscriptView via the
// bundle's own TranscriptRenderer and asserts the caret block the user spec'd
// in 0.5.5: "Session Compacted · N tokens compacted · Session size M",
// collapsing/expanding, plus the live "Compacting..." tail line.
//
// Usage: npm run check                    (builds first)
//        node test/compaction-caret-check.mjs   (uses existing dist/main.js)

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });

const { createRequire, Module } = await import("node:module");
const stub = await import("./obsidian-stub.mjs");

// The stub installs its own fake document/window at import time (headless
// ergonomics) — real React rendering needs the real DOM, so restore jsdom's
// globals AFTER the stub loads. In Obsidian these globals are always real.
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.ResizeObserver = dom.window.ResizeObserver ?? globalThis.ResizeObserver;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window) ?? ((fn) => setTimeout(fn, 16));
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window) ?? clearTimeout;

// Obsidian ships its DOM helpers (createDiv/empty/addClass/…) as prototype
// extensions on HTMLElement — install native versions so ChatView can build
// its DOM on jsdom elements exactly as it does inside Obsidian.
const proto = dom.window.HTMLElement.prototype;
const tokens = (cs) => cs.flatMap((c) => String(c).split(/\s+/)).filter(Boolean);
proto.createEl = function (tag, o = {}) {
  const el = document.createElement(tag);
  if (typeof o === "string") el.textContent = o;
  else {
    if (o.cls) tokens(Array.isArray(o.cls) ? o.cls : [o.cls]).forEach((c) => el.classList.add(c));
    if (o.text !== undefined) el.textContent = o.text;
    if (o.type) el.setAttribute("type", o.type);
    if (o.value !== undefined) el.value = o.value;
    if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
    if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
  }
  this.appendChild(el);
  return el;
};
proto.createDiv = function (o) { return this.createEl("div", o); };
proto.createSpan = function (o) { return this.createEl("span", o); };
proto.empty = function () { this.replaceChildren(); };
proto.addClass = function (...cs) { this.classList.add(...tokens(cs)); };
proto.removeClass = function (...cs) { this.classList.remove(...tokens(cs)); };
proto.toggleClass = function (c, on) { this.classList.toggle(c, on); };
proto.setText = function (v) { this.textContent = String(v); };
proto.getText = function () { return this.textContent; };
proto.setAttr = function (k, v) { this.setAttribute(k, v); };
proto.isShown = function () { return true; };
// Stub setIcon writes el.attrs["data-icon"] — FakeElement has .attrs; give
// jsdom elements a per-element lazily-created one too.
Object.defineProperty(proto, "attrs", {
  get() {
    if (!this._attrs) this._attrs = {};
    return this._attrs;
  },
});

// FakeElement parents (ItemView.contentEl etc.) must spawn real DOM children —
// that's how the transcript container reaches react-dom's createRoot.
const makeEl = proto.createEl;
stub.FakeElement.prototype.createEl = function (tag, o) {
  return makeEl.call({ appendChild: (n) => { this.children.push(n); return n; } }, tag, o);
};
stub.FakeElement.prototype.createDiv = function (o) { return this.createEl("div", o); };
stub.FakeElement.prototype.createSpan = function (o) { return this.createEl("span", o); };

const origLoad = Module._load;
Module._load = (id, parent, isMain) => (id === "obsidian" ? stub : origLoad(id, parent, isMain));
const require = createRequire(import.meta.url);
let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const bundle = require("../dist/main.js");
const PiPlugin = bundle.default ?? bundle;
const appStub = {
  vault: { adapter: { read: async () => { throw new Error("stub: no vault files"); } } },
  workspace: {
    on: () => ({}),
    getLeavesOfType: () => [],
    iterateRootLeaves: () => {},
    activeLeaf: null,
    revealLeaf: () => {},
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();
plugin.getClient = () => ({ baseUrl: "http://machine.test", getModels: async () => ({ models: {} }) });

// Steal the bundle's real TranscriptRenderer through an open chat view.
const view = plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
await view.open();
const Renderer = Object.getPrototypeOf(view.transcript).constructor;
await view.close();

const render = async (units, extra = {}) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = new Renderer(host, { app: appStub, sourcePath: "/tmp", component: new stub.Component() });
  r.update({
    units,
    streaming: null,
    modelNames: {},
    cwd: "/tmp",
    sessionId: "s-1",
    ...extra,
  });
  await new Promise((res) => setTimeout(res, 50)); // flush React commits
  return { host, r };
};

const compactionMsg = (details) => ({
  role: "custom",
  customType: "compaction",
  content: "## Goal\nBuild **Planner**.\n\n## Key Decisions\n- Flutter",
  display: true,
  details,
  timestamp: Date.now(),
});
const plain = (message) => ({ kind: "message", tag: "plain", key: message, message });

// 1 — fresh compaction (0.5.5 user spec): full caret with both numbers.
{
  const msg = compactionMsg({ tokensBefore: 305228, firstKeptEntryId: "c7355268", estimatedTokensAfter: 25000 });
  const { host, r } = await render([plain(msg)]);
  const text = host.textContent ?? "";
  ok(text.includes("Session Compacted"), "caret header renders (Session Compacted)");
  ok(text.includes("305,228 tokens compacted"), `caret shows tokens compacted (got: ${text.slice(0, 120)})`);
  ok(text.includes("Session size 25,000"), "caret shows the post-compaction session size");
  ok(!text.includes("## Goal"), "summary stays collapsed behind the caret");
  r.unmount();
}

// 2 — historical compaction (no estimate): numbers before-only, never stale.
{
  const msg = compactionMsg({ tokensBefore: 305228, firstKeptEntryId: "c7355268" });
  const { host, r } = await render([plain(msg)]);
  const text = host.textContent ?? "";
  ok(text.includes("Session Compacted · 305,228 tokens compacted"), "historical caret shows tokens compacted");
  ok(!text.includes("Session size"), "historical caret drops the size clause (no stale number)");
  r.unmount();
}

// 3 — live tail line: "Compacting..." while compacting, gone when done.
{
  const { host: on, r: r1 } = await render([plain(compactionMsg({ tokensBefore: 10 }))], { compacting: true });
  ok((on.textContent ?? "").includes("Compacting..."), "live compaction shows the Compacting... tail line");
  r1.unmount();
  const { host: off, r: r2 } = await render([plain(compactionMsg({ tokensBefore: 10 }))], { compacting: false });
  ok(!(off.textContent ?? "").includes("Compacting..."), "tail line clears when compaction finishes");
  r2.unmount();
}

// 4 — FULL ChatView flow (the reported bug's exact shape): open a session,
// hit compact, watch the store drive the real view. Before: "Compacting...";
// after: the caret block replaces it in the transcript.
{
  const before = {
    live: false, filePath: "/tmp/c.jsonl", leafId: null, tree: null,
    context: {
      entryIds: ["e0", "e1"],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "hi there" }], timestamp: 2 },
      ],
    },
    info: { cwd: "/tmp", name: "compact me", firstMessage: "hello" },
  };
  const after = {
    ...before,
    // Realistic post-compaction projection (pi's buildContextEntries): the
    // compaction message sits at the HEAD with the kept recent turn after it —
    // the history caret is at the top of a scrolled-down transcript, so the
    // tail caret is the only one the user sees without scrolling.
    context: {
      entryIds: ["e2", "e3", "e4"],
      messages: [
        compactionMsg({ tokensBefore: 305228, firstKeptEntryId: "e3" }),
        { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "on it" }], timestamp: 4 },
      ],
    },
  };
  let payload = before;
  let releaseCompact; // the RPC stays in flight while we sample the tail line
  plugin.getClient = () => ({
    baseUrl: "http://machine.test",
    getModels: async () => ({ models: {} }),
    getState: async () => ({ running: false }),
    getSession: async () => payload,
    getSessionContext: async () => payload.context,
    sendCommand: async () => {
      await new Promise((res) => { releaseCompact = res; });
      return { data: { tokensBefore: 305228, estimatedTokensAfter: 25000 } };
    },
  });
  const v = plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
  await v.open();
  const store = v.getStore();
  await store.openSession("s-flow");
  await new Promise((res) => setTimeout(res, 80));
  const compactDone = store.compact();
  await new Promise((res) => setTimeout(res, 10));
  const during = v.transcriptEl.textContent ?? "";
  ok(during.includes("Compacting..."), "hitting compact shows the Compacting... tail line (full flow)");
  // 0.5.21 (user spec): only Stop shows while compacting — the disabled Send
  // and Queue/steer buttons next to it were noise.
  ok(v.sendGroupEl.style.display === "none" && v.queueBtnEl.style.display === "none",
    "during compaction only Stop shows (send + queue hidden)");
  ok(v.runGroupEl.style.display === "", "the Stop group shows during compaction");
  payload = after; // compaction lands on disk while the RPC runs
  releaseCompact();
  await compactDone;
  await new Promise((res) => setTimeout(res, 80));
  ok(v.sendGroupEl.style.display === "" && v.queueBtnEl.style.display === "",
    "after compaction the send/queue buttons return");
  const text = v.transcriptEl.textContent ?? "";
  ok(text.includes("Session size 25,000"),
    "full flow: tail caret replaces the Compacting... line in place (size clause = tail caret's signature)");
  ok(text.includes("Session Compacted · 305,228 tokens compacted"),
    `full flow: caret with tokens compacted (got: ${text.slice(0, 150)})`);
  ok(!text.includes("Compacting..."), "full flow: tail line is gone after compaction");
  // 0.5.33 (device bug): the completion caret must stay INLINE at the seam —
  // new messages flow BELOW it, not above a bottom-pinned banner.
  payload = {
    ...after,
    context: {
      entryIds: ["e2", "e3", "e4", "e5"],
      messages: [
        ...after.context.messages,
        { role: "user", content: [{ type: "text", text: "what now" }], timestamp: 5 },
      ],
    },
  };
  await store.refreshFromDisk();
  await new Promise((res) => setTimeout(res, 80));
  const flowed = v.transcriptEl.textContent ?? "";
  // NOTE: message TEXT never renders in this harness (markdown is stubbed) —
  // the new user message's "Edit from here" action row is its DOM anchor.
  ok(
    flowed.indexOf("Session size 25,000") < flowed.indexOf("Edit from here"),
    "0.5.33: the caret stays at the seam (new messages render BELOW it)",
  );
  await v.close();
}

// 5 — run-state guard: a NORMAL run keeps the steer button (only compaction
// hides it).
{
  const v = plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
  await v.open();
  v.getStore().update({ agentRunning: true });
  await new Promise((res) => setTimeout(res, 20));
  ok(v.queueBtnEl.style.display === "", "steer button stays visible during a normal run");
  ok(v.sendGroupEl.style.display === "none", "send group hides during a run");
  ok(v.runGroupEl.style.display === "", "Stop group shows during a run");
  await v.close();
}

// 6 — loader survives the REAL React mount (0.5.23 root cause): react-dom's
// createRoot clears its container's existing children, and this harness is the
// only one where createRoot actually mounts (the plain-stub renders no-op) —
// so this is the check that would have caught "loader never shows".
{
  const v = plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
  await v.open();
  const store = v.getStore();
  store.update({ loading: true, messages: [] });
  await new Promise((res) => setTimeout(res, 40)); // let React mount into the host
  ok(v.loaderEl.parentElement === v.transcriptEl,
    "loader still parented to the transcript after react-dom mounted (not cleared)");
  ok(v.loaderEl.style.display !== "none", "loader visible while loading after mount");
  store.update({ loading: false, messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }], display: true }] });
  await new Promise((res) => setTimeout(res, 40));
  ok(v.loaderEl.parentElement === v.transcriptEl && v.loaderEl.style.display === "none",
    "loader still parented and hidden once the session settles");
  await v.close();
}

console.log(failures === 0 ? "compaction-caret-check: all green" : `compaction-caret-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
