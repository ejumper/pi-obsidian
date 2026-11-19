// 0.5.25 regression check — voice prompt seeding (user reported prompts/ never
// appearing in the plugin dir on phone OR desktop). Root cause: the dir passed
// to loadVoicePrompts came from manifest.dir (filesystem-absolute), which the
// vault adapter can't read or write — so the seed silently failed everywhere
// and voice mode ran on the compiled fallback. The call site now passes a
// VAULT-RELATIVE dir (configDir + plugins/<id>); this harness pins the
// loadVoicePrompts contract: read the vault-relative path, seed it on miss,
// prefer an existing file, fall back to compiled without a reader.
// Drives the REAL built bundle's exported loadVoicePrompts.
//
// Usage: npm run check                (builds first)
//        node test/prompts-seed-check.mjs

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
const { loadVoicePrompts, parsePromptFile } = bundle;

// Fake adapter recording every path it is asked about.
const reads = [];
const writes = [];
let files = new Map();
const adapter = {
  async read(path) {
    reads.push(path);
    if (files.has(path)) return files.get(path);
    throw new Error("file not found");
  },
  async write(path, data) {
    writes.push(path);
    files.set(path, data);
  },
};

const raw = `<!-- some header comment the model never sees -->
---
<voice-mode>
be terse
</voice-mode>`;

// 1 — missing file: seeded at the VAULT-RELATIVE path, compiled copy serves
// this load, and the NEXT load reads the seeded file.
{
  files = new Map();
  reads.length = 0; writes.length = 0;
  const dir = ".obsidian/plugins/pi-obsidian";
  const prompts = await loadVoicePrompts(adapter, dir);
  ok(reads.length === 2, `both prompt files probed (got ${reads.length})`);
  ok(reads[0] === `${dir}/prompts/voice-enter.md`, `enter probed vault-relatively (got ${reads[0]})`);
  ok(writes.length === 2, `both files seeded on miss (got ${writes.length})`);
  ok(writes[0] === `${dir}/prompts/voice-enter.md`, "seed write uses the same vault-relative path");
  const again = await loadVoicePrompts(adapter, dir);
  ok(again.enter.includes("<voice-mode>"), "seeded file wins on the next load");
  ok(again.enter.length > 0 && !again.enter.includes("<!--"),
    "seeded file parsed through the --- marker (comment header stripped)");
}

// 2 — an existing (user-edited) file is preferred and parsed; never rewritten.
{
  files = new Map([
    [".obsidian/plugins/pi-obsidian/prompts/voice-enter.md", raw],
  ]);
  writes.length = 0;
  const prompts = await loadVoicePrompts(adapter, ".obsidian/plugins/pi-obsidian");
  ok(prompts.enter.includes("be terse"), "user-edited file wins over the compiled copy");
  ok(!prompts.enter.includes("header comment"), "comment above the --- marker is stripped");
  ok(!writes.some((w) => w.endsWith("voice-enter.md")), "existing files are not rewritten (only the missing exit seeds)");
}

// 3 — no reader / no dir: compiled fallback serves, nothing crashes.
{
  const prompts = await loadVoicePrompts(undefined, undefined);
  ok(typeof prompts.enter === "string" && prompts.enter.includes("<voice-mode>"), "compiled fallback without a reader");
  ok(typeof prompts.exit === "string", "exit prompt falls back too");
}

// 4 — parsePromptFile contract pin (marker handling).
ok(parsePromptFile("no marker here", "FB") === "no marker here", "file without --- marker is used whole");
ok(parsePromptFile("header\n---\nbody text", "FB") === "body text", "body after the --- marker is the prompt");

console.log(failures === 0 ? "prompts-seed-check: all green" : `prompts-seed-check: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
