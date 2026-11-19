// 0.5.22 regression check — center-of-screen session loader (user spec).
// 0.5.17 removed the top-right "loading" status; opening a session then read
// as a blank screen. The loader fills the empty transcript, centered, with an
// animated ellipsis (dots appear one at a time, then all clear, looping —
// CSS keyframes; the JS side only toggles display on the loading flag).
// Drives the REAL built bundle against the stub.
//
// Usage: npm run check           (builds first)
//        node test/loading-check.mjs   (uses existing dist/main.js)

import { createRequire, Module } from "node:module";
import { readFileSync } from "node:fs";

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
plugin.getClient = () => ({
  baseUrl: "http://machine.test",
  getModels: async () => ({ models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {} }),
});

const makeView = () => plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} });
const visible = (v) => v.loaderEl.style.display !== "none";

// 1 — the loader exists inside the transcript with three dot spans, and is
// hidden while nothing is loading.
{
  const v = makeView();
  await v.open();
  ok(v.loaderEl && v.transcriptEl.children.includes(v.loaderEl),
    "loader lives inside the transcript");
  const kids = v.loaderEl.children;
  ok(kids[0]?.textContent === "loading", `first child is the "loading" text (got "${kids[0]?.textContent}")`);
  const dots = kids[1]?.classes?.has("pi-loader-dots") ? kids[1].children : [];
  ok(dots.length === 3 && dots.every((d) => d.textContent === "."),
    `three dot spans (got ${dots.length})`);
  ok(!visible(v), "loader hidden when not loading");
  await v.close();
}

// 2 — the loading flag drives the loader: openSession sets loading:true with
// messages cleared (blank transcript), so the loader shows; settle hides it.
{
  const v = makeView();
  await v.open();
  const store = v.getStore();
  store.update({ loading: true, messages: [] });
  await new Promise((r) => setTimeout(r, 20));
  ok(visible(v), "loader shows while loading");
  store.update({ loading: false, messages: [{ id: "m1", role: "assistant", content: [{ type: "text", text: "hi" }], display: true }] });
  await new Promise((r) => setTimeout(r, 20));
  ok(!visible(v), "loader hides when the session settles");
  // Toggle back on (a second open) — change-on-edge logic must not stick.
  store.update({ loading: true, messages: [] });
  await new Promise((r) => setTimeout(r, 20));
  ok(visible(v), "loader shows again on a re-open");
  await v.close();
}

// 3 — the loader must live OUTSIDE the React host (0.5.23 root cause):
// react-dom's createRoot() clears its container's existing children on first
// mount — a loader inside the host gets silently deleted and its display
// toggles a detached node ("never shows"). Pin the sibling structure.
{
  const v = makeView();
  await v.open();
  ok(v.transcriptHostEl && v.transcriptHostEl !== v.transcriptEl,
    "React mounts into its own host, not the transcript root");
  ok(v.transcriptEl.children.includes(v.transcriptHostEl) && v.transcriptEl.children.includes(v.loaderEl),
    "host and loader are siblings under the transcript");
  ok(v.transcriptHostEl.children.indexOf(v.loaderEl) === -1,
    "loader is NOT inside the React container (createRoot clears it)");
  await v.close();
}

// 4 — a view opened onto an ALREADY-loading store shows the loader immediately
// (initial display comes from current state, not a stale "hidden").
{
  plugin.__storeSeed = { loading: true }; // if the factory honors seeds; harmless otherwise
  const v = makeView();
  await v.open();
  if (v.getStore().state.loading) {
    ok(visible(v), "loader visible immediately when opened mid-load");
  } else {
    console.log("SKIP  (fresh store not loading — seed unsupported)")
  }
  await v.close();
}

// 5 — styles.css: the centered full-height rule + the three cumulative dot
// keyframes (appear one at a time, all clear together).
{
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  ok(/pi-session-loader[^}]*height:\s*100%/.test(css), "loader fills the transcript height (centers mid-screen)");
  for (const [n, on, off] of [[1, "0%, 74%", null], [2, "25%, 74%", "0%, 24%"], [3, "50%, 74%", "0%, 49%"]]) {
    const re = new RegExp(`pi-dot-${n}[\\s\\S]{0,80}${on.replace(/%/g, "%").replace(/,\s/g, ",\\s*")}[\\s\\S]{0,40}75%, 100%`);
    ok(re.test(css), `pi-dot-${n} keyframe window present (on ${on}, all clear at 75%)`);
    if (off) {
      const offRe = new RegExp(`pi-dot-${n}[\\s\\S]{0,120}${off.replace(/,\s/g, ",\\s*")}`);
      ok(offRe.test(css), `pi-dot-${n} starts hidden (${off})`);
    }
  }
}

console.log(failures === 0 ? "loading-check: all green" : `loading-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
