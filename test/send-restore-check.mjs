// 0.5.24 regression check — failed sends return the draft to the composer
// (user spec: "the message returns to the composer… possible?"). A message
// that never reached the model must never cost retyping:
//   1. HTTP send failure (sendPrompt/startNewSession/steer catch) → the
//      verbatim editor text comes back (plus the new-session cwd).
//   2. Async prompt_error where the message never landed in the session →
//      the store asks (onSendFailed) and the composer gets it back.
//   3. prompt_error where the message DID land (persisted) → no restore
//      (would duplicate), and a successful send never restores.
// Drives the REAL built bundle against the stub.
//
// Usage: npm run check           (builds first)
//        node test/send-restore-check.mjs   (uses existing dist/main.js)

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

const bundle = require("../dist/main.js");
const PiPlugin = bundle.default ?? bundle;
const appStub = {
  vault: { adapter: { read: async () => { throw new Error("stub: no vault files"); } } },
  workspace: {
    on: () => ({}),
    getLeavesOfType: () => [],
    iterateRootLeaves: () => {},
    getLeaf: () => ({}),
    activeLeaf: null,
    revealLeaf: () => {},
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();
plugin.settings.includeMentions = false; // mention prefixing is its own feature

// Mutable fake client — each scenario points sendImpl/sessionDetail where it
// needs them.
let sendImpl = async () => ({ data: null });
let sessionDetail = { context: { messages: [], entryIds: [] }, tree: null, leafId: null, info: null };
const client = {
  baseUrl: "http://machine.test",
  getModels: async () => ({ models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {} }),
  getSession: async () => sessionDetail,
  getState: async () => ({ running: false }),
  sendCommand: async (...args) => sendImpl(...args),
};
plugin.getClient = () => client;

const makeView = () => plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// 1 — HTTP send failure: verbatim draft returns to the composer.
{
  const v = makeView();
  await v.open();
  const store = v.getStore();
  store.ensureConnected = async () => {}; // no SSE in the stub
  store.update({ sessionId: "s1", cwd: "/home/test", loading: false });
  sendImpl = async () => { throw new Error("HTTP 500 boom"); };
  v.inputEl.value = "please fix the bug\n  (keep the indent)";
  await v.sendCurrent();
  await tick();
  ok(v.inputEl.value === "please fix the bug\n  (keep the indent)",
    `verbatim draft restored after HTTP failure (got ${JSON.stringify(v.inputEl.value)})`);
  ok(store.state.messages.length === 0, "optimistic bubble rolled back");
  await v.close();
}

// 2 — steer failure: same restore (queue/steer paths use the same contract).
{
  const v = makeView();
  await v.open();
  const store = v.getStore();
  store.ensureConnected = async () => {};
  store.update({ sessionId: "s1", agentRunning: true });
  sendImpl = async () => { throw new Error("link down"); };
  v.inputEl.value = "also rename the file";
  await v.sendCurrent();
  await tick();
  ok(v.inputEl.value === "also rename the file", "draft restored after steer failure");
  await v.close();
}

// 3 — new-session failure: draft AND the pending cwd come back (title too).
{
  const v = makeView();
  await v.open();
  const store = v.getStore();
  store.ensureConnected = async () => {};
  v.prepareNewSession("/home/test/proj");
  sendImpl = async () => { throw new Error("bridge refused"); };
  v.inputEl.value = "start here";
  await v.sendCurrent();
  await tick();
  ok(v.inputEl.value === "start here", "draft restored after new-session failure");
  ok(v.pendingCwd === "/home/test/proj", "pending cwd restored (resend works without re-picking)");
  await v.close();
}

// 4 — async prompt_error where the message never landed: the store fires
// onSendFailed and the composer gets it back; runError still renders.
{
  const v = makeView();
  await v.open();
  const store = v.getStore();
  store.ensureConnected = async () => {};
  store.update({ sessionId: "s1", cwd: "/home/test", loading: false });
  sendImpl = async () => ({ data: null }); // accepted by the bridge…
  sessionDetail = { context: { messages: [], entryIds: [] }, tree: null, leafId: null, info: null };
  v.inputEl.value = "where did the file go";
  await v.sendCurrent();
  await tick();
  ok(v.inputEl.value === "", "successful accept leaves the composer empty");
  store.handleFrame({ type: "prompt_error", errorMessage: "model exploded" }); // …but pi rejected it
  await tick(80);
  ok(v.inputEl.value === "where did the file go",
    `prompt_error without a persisted entry restores the draft (got ${JSON.stringify(v.inputEl.value)})`);
  ok(store.state.runError === "model exploded", "runError still renders as session output");
  await v.close();
}

// 5 — prompt_error where the message DID land: no restore (it lives in the
// transcript; restoring would duplicate on resend).
{
  const v = makeView();
  await v.open();
  const store = v.getStore();
  store.ensureConnected = async () => {};
  store.update({ sessionId: "s1", cwd: "/home/test", loading: false });
  sendImpl = async () => ({ data: null });
  v.inputEl.value = "this one persisted";
  await v.sendCurrent();
  await tick();
  sessionDetail = {
    context: {
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "this one persisted" }], display: true }],
      entryIds: ["u1"],
    },
    tree: null, leafId: null, info: null,
  };
  store.handleFrame({ type: "prompt_error", errorMessage: "timeout after the entry was written" });
  await tick(80);
  ok(v.inputEl.value === "", "no restore when the message persisted on disk");
  await v.close();
}

console.log(failures === 0 ? "send-restore-check: all green" : `send-restore-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
