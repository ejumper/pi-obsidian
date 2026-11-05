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

const appStub = { workspace: { on: () => ({}) } };
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
