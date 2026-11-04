// Open-file `@mention` support for outgoing prompts (PLAN/PHASES/PHASE-5.md T26,
// format per Pi-Web doc 1_41). Pure helpers — no UI: the include toggle and badge
// live in the composer, and the badge count is collectOpenFiles(app).length.
//
// Adaptation vs pi-web: pi-web mentions a single "effective file tab"; we attach
// EVERY file open in a workspace tab (deduped), gated by the composer's toggle.

import { FileView, TFile, type App, type WorkspaceLeaf } from "obsidian";

export interface MentionFile {
  file: TFile;
  /** absolute server path */
  serverPath: string;
}

/** Resolve the file backing a leaf; deferred background tabs expose it via view state. */
function fileOfLeaf(app: App, leaf: WorkspaceLeaf): TFile | null {
  const view = leaf.view;
  if (view instanceof FileView) return view.file;
  // Deferred tabs hold a placeholder view instead of the real (file) view — the
  // saved view state still names the file.
  if (leaf.isDeferred) {
    const state = leaf.getViewState().state;
    const path = state?.file;
    if (typeof path === "string" && path.trim() !== "") {
      const abstract = app.vault.getAbstractFileByPath(path);
      if (abstract instanceof TFile) return abstract;
    }
  }
  return null;
}

/** All files open in workspace tabs, deduped by path, sorted by path. */
export function collectOpenFiles(app: App): TFile[] {
  const byPath = new Map<string, TFile>();
  app.workspace.iterateAllLeaves((leaf) => {
    const file = fileOfLeaf(app, leaf);
    if (!file || file.path.trim() === "") return;
    if (!byPath.has(file.path)) byPath.set(file.path, file);
  });
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Map vault files to server paths using a resolved server prefix. */
export function mapServerPaths(files: TFile[], serverPrefix: string): MentionFile[] {
  const prefix = serverPrefix.replace(/\/+$/, "");
  return files.map((file) => ({ file, serverPath: `${prefix}/${file.path}` }));
}

/**
 * Build the mention prefix lines per pi-web's format: one line per file,
 * path relative to the session cwd when under it, absolute otherwise,
 * each line = "@<path> " (trailing space) — caller joins and prepends as
 * `${prefix}\n${message}`. Empty array = no mentions.
 */
export function buildMentionPrefix(files: MentionFile[], sessionCwd: string): string[] {
  const rawCwd = sessionCwd.trim();
  const cwd = rawCwd.replace(/\/+$/, ""); // "/" normalizes to "" — still matches every absolute path
  const lines: string[] = [];
  for (const { serverPath } of files) {
    if (serverPath.trim() === "") continue;
    let path = serverPath;
    // Under cwd only when followed by a separator (cwd + "/"); an empty cwd
    // means no cwd, so every mention stays absolute.
    if (rawCwd !== "" && path.startsWith(cwd + "/")) path = path.slice(cwd.length + 1);
    if (path.trim() === "") continue;
    // pi-web parity: paths with spaces are quoted (lib/file-fuzzy.ts).
    lines.push(path.includes(" ") ? `@"${path}" ` : `@${path} `);
  }
  return lines;
}
