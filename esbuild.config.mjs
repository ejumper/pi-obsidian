import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

// Short git hash baked into the bundle so the UI can show which build is live
// (catches stale syncs at a glance).
let buildId = "dev";
try {
  buildId = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
} catch {
  // not a git checkout — keep "dev"
}

// Build output goes straight into the vault's plugin folder so Hot Reload picks it up.
const VAULT_PLUGIN_DIR = path.join(
  os.homedir(),
  "HalfaCloud/Jumperpedia/.obsidian/plugins/pi-obsidian"
);

const prod = process.argv[2] === "production";

function copyStatic() {
  fs.mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync("manifest.json", path.join(VAULT_PLUGIN_DIR, "manifest.json"));
  fs.copyFileSync("styles.css", path.join(VAULT_PLUGIN_DIR, "styles.css"));
  // Marker file for pjeby's Hot Reload plugin.
  fs.writeFileSync(path.join(VAULT_PLUGIN_DIR, ".hotreload"), "");
}

function stageDist() {
  for (const f of ["main.js", "manifest.json", "styles.css"]) {
    const src = f === "main.js" ? path.join(VAULT_PLUGIN_DIR, f) : f;
    fs.copyFileSync(src, path.join("dist", f));
  }
}

copyStatic();

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  loader: { ".md": "text" },
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  outfile: path.join(VAULT_PLUGIN_DIR, "main.js"),
});

if (prod) {
  await context.rebuild();
  await context.dispose();
  stageDist();
} else {
  await context.watch();
  console.log(`watching → ${VAULT_PLUGIN_DIR}`);
}
