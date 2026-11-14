// Headless regression check — loads the REAL built bundle against the
// Obsidian stub and opens the views. Catches the class of bugs that shipped
// to devices before: base-class field clobbering (the blank-view bug), DOM
// helper gaps, constructor throws, module-eval failures.
//
// Usage: npm run check        (builds first)
//        node test/headless-check.mjs   (uses existing dist/main.js)

import { createRequire, Module } from "node:module";

const stub = await import("./obsidian-stub.mjs");

// Route the bundle's require("obsidian") to the stub.
const origLoad = Module._load;
Module._load = (id, parent, isMain) =>
  id === "obsidian" ? stub : origLoad(id, parent, isMain);

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

try {
  await plugin.onload();
  ok(true, "onload completes");
} catch (e) {
  ok(false, `onload completes — ${e}`);
  process.exit(1);
}

ok(typeof plugin.__views["pi-chat"] === "function", "chat view registered");
ok(typeof plugin.__views["pi-panel"] === "function", "panel view registered");

for (const type of ["pi-chat", "pi-panel"]) {
  const leaf = { app: appStub, updateHeader() {} };
  const view = plugin.__views[type](leaf);
  try {
    await view.open();
    const kids = view.contentEl.children;
    const painted = kids.some?.((k) => k.classes?.has("pi-error-panel")) ?? false;
    ok(!painted, `${type} opens without painting an error panel`);
    const expected = type === "pi-chat" ? 2 : 3; // chat's composer is body-attached
    ok((kids.length ?? 0) >= expected, `${type} builds its DOM (${kids.length} top-level children)`);
    await view.close();
  } catch (e) {
    ok(false, `${type} opens — ${e}`);
  }
}

// T43 — two pi-chat views open at once: both paint, and closing one leaves
// the other working (per-view stores, per-view composers).
const twins = [
  plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} }),
  plugin.__views["pi-chat"]({ app: appStub, updateHeader() {} }),
];
try {
  await twins[0].open();
  await twins[1].open();
  ok(twins[0].getStore() !== twins[1].getStore(), "twin chat views have independent stores");
  for (const [i, twin] of twins.entries()) {
    const kids = twin.contentEl.children;
    const painted = kids.some?.((k) => k.classes?.has("pi-error-panel")) ?? false;
    ok(!painted, `twin chat view ${i + 1} opens without painting an error panel`);
    ok((kids.length ?? 0) >= 2, `twin chat view ${i + 1} builds its DOM (${kids.length} top-level children)`);
  }

  await twins[0].close();

  // The survivor still responds: a store update re-renders through its own
  // subscription — a throw would swap contentEl for the error panel.
  const survivor = twins[1];
  survivor.prepareNewSession("/tmp");
  const kids = survivor.contentEl.children;
  const painted = kids.some?.((k) => k.classes?.has("pi-error-panel")) ?? false;
  ok(!painted, "surviving chat view still responds after its sibling closes (no error panel)");
  ok((kids.length ?? 0) >= 2, `surviving chat view keeps its DOM (${kids.length} top-level children)`);
  await survivor.close();
} catch (e) {
  ok(false, `two chat views coexist — ${e}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
