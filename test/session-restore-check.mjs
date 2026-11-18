// PHASE-16 regression check — tab session + draft restore across restarts:
// the getState/setState round trip, verify-first restore, and the fallback
// policy (deleted/unreachable session -> new-session + Notice; the draft
// restores either way). Drives the REAL built bundle against the stub.
//
// Usage: npm run check          (builds first)
//        node test/session-restore-check.mjs   (uses existing dist/main.js)

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
    activeLeaf: null,
    revealLeaf: () => {},
  },
};
const plugin = new PiPlugin(appStub, { version: "test", id: "pi-obsidian" });
await plugin.onload();

// Mock client: records getSession calls; behavior is swapped per scenario.
const calls = [];
const okPayload = {
  live: false,
  filePath: "/tmp/restore.jsonl",
  leafId: null,
  tree: null,
  context: { entryIds: [], messages: [] },
  info: { cwd: "/tmp", name: "restored", firstMessage: "" },
};
let getSessionImpl = async () => okPayload;
plugin.getClient = () => ({
  getSession: async (id) => {
    calls.push(id);
    return getSessionImpl(id);
  },
});

const makeView = () => plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
const tick = () => new Promise((r) => setTimeout(r, 20));

// 1 — happy path: setState after open restores session + draft, state round-trips.
{
  calls.length = 0;
  stub.Notice.messages.length = 0;
  const v = makeView();
  await v.open();
  await v.setState({ instanceId: plugin.settings.instances[0].id, sessionId: "s-1", draft: "hello there" });
  await tick();
  ok(calls.includes("s-1"), "restore verifies the session on the machine first");
  ok(v.getStore()?.state.sessionId === "s-1", "session binds through the normal open path");
  const st = v.getState();
  ok(st.sessionId === "s-1" && st.draft === "hello there", "getState round-trips session + draft");
  ok(stub.Notice.messages.length === 0, "happy path raises no notice");
  await v.close();
}

// 2 — deleted session (404): fallback to new-session + notice; draft still restores.
{
  calls.length = 0;
  stub.Notice.messages.length = 0;
  getSessionImpl = async () => {
    throw { status: 404, message: "not found" };
  };
  const v = makeView();
  await v.open();
  await v.setState({ instanceId: plugin.settings.instances[0].id, sessionId: "s-gone", draft: "keep me" });
  await tick();
  ok(!v.getStore()?.state.sessionId, "deleted session leaves the tab on new-session");
  ok(stub.Notice.messages.some((m) => m.includes("gone")), "deleted session raises the 'gone' notice");
  ok(v.getState().draft === "keep me", "draft restores even when the session is gone");
  await v.close();
}

// 3 — unreachable machine (network error): distinct notice, tab still fine.
{
  calls.length = 0;
  stub.Notice.messages.length = 0;
  getSessionImpl = async () => {
    throw new Error("fetch failed");
  };
  const v = makeView();
  await v.open();
  await v.setState({ instanceId: plugin.settings.instances[0].id, sessionId: "s-far", draft: "" });
  await tick();
  ok(!v.getStore()?.state.sessionId, "unreachable machine leaves the tab on new-session");
  ok(stub.Notice.messages.some((m) => m.includes("reach")), "unreachable machine raises the 'reach' notice");
  await v.close();
}

// 4 — ordering dance: setState BEFORE open still restores once the view exists.
{
  calls.length = 0;
  stub.Notice.messages.length = 0;
  getSessionImpl = async () => okPayload;
  const v = makeView();
  await v.setState({ instanceId: plugin.settings.instances[0].id, sessionId: "s-early", draft: "early" });
  await v.open();
  await tick();
  ok(v.getStore()?.state.sessionId === "s-early", "setState before open restores after open");
  ok(v.getState().draft === "early", "early draft lands in the composer");
  await v.close();
}

// 5 — legacy state shape (instanceId only): no restore, no notice.
{
  calls.length = 0;
  stub.Notice.messages.length = 0;
  const v = makeView();
  await v.open();
  await v.setState({ instanceId: plugin.settings.instances[0].id });
  await tick();
  ok(calls.length === 0 && stub.Notice.messages.length === 0, "legacy state (no session) restores as before");
  ok(!v.getStore()?.state.sessionId, "legacy state leaves the tab on new-session");
  await v.close();
}

console.log(failures === 0 ? "session-restore-check: all green" : `session-restore-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
