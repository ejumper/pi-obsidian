// ServerTree — the panel's "Folders" mode: a lazy directory tree of a REMOTE
// server filesystem, styled after Obsidian's file explorer and session-oriented
// (every directory carries a pinned "[ New session ]" row plus its sessions).
// Pure DOM (Obsidian createEl/createDiv helpers + setIcon), no React.
//
// Store-free and transport-free by design: listDir, getSessions, and the
// new/open-session callbacks all arrive via the constructor — this file never
// touches the API client or the session store. Directory listings are cached
// per path until setRoot()/refresh(); session rows reuse the .pi-session-*
// classes from the Recent list so both modes look identical.
//
// Session rows re-render (from getSessions) whenever a directory's children
// are (re)built; call refresh() after sessions change.

import { setIcon } from "obsidian";
import type { SessionInfo } from "../../api/types";

export interface TreeDirEntry {
  name: string;
  isDir: boolean;
}

export interface ServerTreeOptions {
  /** Absolute server path shown as the tree root, e.g. "/home/u/HalfaCloud/Jumperpedia". */
  rootPath: string;
  /** Lists one directory. 403 "Access denied" is expected for some dirs — it
   *  surfaces as a muted "error: …" row, never as a throw. */
  listDir: (path: string) => Promise<TreeDirEntry[]>;
  /** Sessions whose cwd == dirPath (caller snapshots; the component never
   *  reads a store and never sorts the caller's array in place). */
  getSessions: (dirPath: string) => SessionInfo[];
  onNewSession: (cwd: string) => void;
  onOpenSession: (id: string) => void;
  /** Ids currently running — rendered with .pi-session-running like the
   *  Recent list. A function is re-evaluated on every (re)build so a live
   *  feed can close over its current set; a plain iterable is a snapshot. */
  runningIds?: Iterable<string> | (() => Iterable<string>);
}

/** A directory row's state while it lives in the tree. */
interface DirNode {
  /** Absolute path of this directory. */
  path: string;
  /** Indent level of the rows INSIDE this node's children container. */
  depth: number;
  expanded: boolean;
  containerEl: HTMLElement;
  rowEl: HTMLElement;
  chevronEl: HTMLElement;
  /** Present only while expanded. */
  childrenEl: HTMLElement | null;
}

const TITLE_MAX_CHARS = 70;

/** Same formatter as SessionList (module-private there; duplicated so this
 *  file stays self-contained). "2025-01-02T03:04:05…" → "2025-01-02 03:04";
 *  falls back to Date, then raw. */
function formatModified(iso: string): string {
  const sliced = iso.slice(0, 16).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sliced)) return sliced;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Trailing slashes off; "/" is the floor ("/home/u/" → "/home/u"). */
function normalizeRoot(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/** listDir rejection → row text; the API may reject with Error, a plain
 *  string, or a parsed `{ error: "Access denied" }` body. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    if (typeof rec.error === "string" && rec.error.length > 0) return rec.error;
    if (typeof rec.message === "string" && rec.message.length > 0) return rec.message;
  }
  return err == null ? "unknown error" : String(err);
}

/** Click + Enter/Space activate, matching the keyboard convention of the
 *  Recent list rows. */
function activateOn(el: HTMLElement, fn: () => void): void {
  el.addEventListener("click", () => fn());
  el.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    ev.preventDefault();
    fn();
  });
}

export class ServerTree {
  /** The component root — the caller places this in its layout. */
  readonly el: HTMLElement;

  private readonly listDir: ServerTreeOptions["listDir"];
  private readonly getSessions: ServerTreeOptions["getSessions"];
  private readonly onNewSession: ServerTreeOptions["onNewSession"];
  private readonly onOpenSession: ServerTreeOptions["onOpenSession"];
  private readonly runningIds: ServerTreeOptions["runningIds"];

  private rootPath: string;
  /** dir path → listDir result; cleared by setRoot()/refresh(). */
  private readonly cache = new Map<string, TreeDirEntry[]>();
  /** Expanded dir paths (the root is always expanded and never tracked);
   *  survives refresh() so expanded dirs are re-fetched, cleared by setRoot(). */
  private readonly expanded = new Set<string>();
  /** In-flight listDir per path, so a rapid collapse/expand dedupes. */
  private readonly inflight = new Map<string, Promise<TreeDirEntry[]>>();
  /** Bumped by setRoot()/refresh(); async continuations from an older
   *  generation discard themselves instead of touching the fresh DOM. */
  private generation = 0;
  /** Children containers still in play (removed on collapse / cleared on
   *  re-render). Deliberately not isConnected: `el` may not be attached to
   *  the document yet while the constructor's first load resolves. */
  private readonly liveContainers = new Set<HTMLElement>();

  constructor(opts: ServerTreeOptions) {
    this.listDir = opts.listDir;
    this.getSessions = opts.getSessions;
    this.onNewSession = opts.onNewSession;
    this.onOpenSession = opts.onOpenSession;
    this.runningIds = opts.runningIds;
    this.rootPath = normalizeRoot(opts.rootPath);

    this.el = createDiv({ cls: "pi-tree" });
    this.render();
  }

  /** Change the root (also used by the ".." row). Clears the listing cache
   *  and the expansion state, then re-renders. */
  setRoot(path: string): void {
    this.rootPath = normalizeRoot(path);
    this.cache.clear();
    this.expanded.clear();
    this.render();
  }

  /** Re-render from the root, re-fetching every expanded dir. */
  refresh(): void {
    this.cache.clear();
    this.render();
  }

  // ---------- rendering ----------

  private render(): void {
    this.generation++;
    this.inflight.clear();
    this.liveContainers.clear();
    this.el.empty();

    // Obsidian-explorer style: the root's contents ARE the top level — no
    // root path line, no ".." row. The tree is confined to rootPath.
    this.fillChildren(this.el, this.rootPath, 0, this.generation);
  }

  /** Builds one directory's children in explorer order: sub-folders first,
   *  then the pinned [ New session ] row, then sessions (modified DESC). */
  private fillChildren(container: HTMLElement, dirPath: string, depth: number, generation: number): void {
    container.empty();
    this.liveContainers.add(container);

    // Dir rows land here (lazily) — kept first in DOM order via this slot.
    const dirSlot = container.createDiv({ cls: "pi-tree-dirs" });

    const newSession = container.createDiv({
      cls: "pi-tree-new-session",
      attr: { tabindex: "0", role: "button" },
    });
    setIcon(newSession.createSpan({ cls: "pi-tree-new-session-icon" }), "plus");
    newSession.createSpan({ text: "[ New session ]" });
    activateOn(newSession, () => this.onNewSession(dirPath));

    const runningIds = this.runningIdsAt();
    for (const session of this.sessionsFor(dirPath)) {
      this.appendSessionRow(container, session, runningIds);
    }

    const cached = this.cache.get(dirPath);
    if (cached) {
      this.appendDirRows(dirSlot, cached, dirPath, depth, generation);
      return;
    }

    // Dir entries still loading: muted status row, replaced in place below.
    const status = dirSlot.createDiv({ cls: "pi-tree-status", text: "loading…" });
    this.load(dirPath, generation).then(
      (entries) => {
        if (!this.isLive(container, generation)) return;
        status.remove();
        this.appendDirRows(dirSlot, entries, dirPath, depth, generation);
      },
      (err: unknown) => {
        if (!this.isLive(container, generation)) return;
        // 403 "Access denied" lands here too — show it, never throw.
        status.setText(`error: ${errorMessage(err)}`);
      }
    );
  }

  /** Async continuation guard: same generation AND this container was not
   *  discarded (a collapse replaced it, or a re-render emptied the tree). */
  private isLive(container: HTMLElement, generation: number): boolean {
    return generation === this.generation && this.liveContainers.has(container);
  }

  /** Directory rows only — files are never listed. Restores expansion for
   *  dirs that were expanded before a refresh(). */
  private appendDirRows(
    container: HTMLElement,
    entries: TreeDirEntry[],
    dirPath: string,
    depth: number,
    generation: number
  ): void {
    for (const entry of entries) {
      if (!entry.isDir) continue;
      const node = this.createDirNode(entry, dirPath, depth);
      container.appendChild(node.containerEl);
      if (this.expanded.has(node.path)) {
        this.setNodeExpanded(node, true, generation);
      }
    }
  }

  private createDirNode(entry: TreeDirEntry, dirPath: string, depth: number): DirNode {
    const path = joinPath(dirPath, entry.name);
    const containerEl = createDiv({ cls: "pi-tree-node" });
    const rowEl = containerEl.createDiv({
      cls: "pi-tree-row",
      attr: { tabindex: "0", role: "button", "aria-expanded": "false", title: entry.name },
    });
    const chevronEl = rowEl.createSpan({ cls: "pi-tree-chevron" });
    setIcon(chevronEl, "chevron-right");
    rowEl.createSpan({ cls: "pi-tree-name", text: entry.name });

    const node: DirNode = {
      path,
      depth,
      expanded: false,
      containerEl,
      rowEl,
      chevronEl,
      childrenEl: null,
    };
    activateOn(rowEl, () => this.toggleNode(node));
    return node;
  }

  private toggleNode(node: DirNode): void {
    const expanded = !node.expanded;
    if (expanded) this.expanded.add(node.path);
    else this.expanded.delete(node.path);
    this.setNodeExpanded(node, expanded, this.generation);
  }

  private setNodeExpanded(node: DirNode, expanded: boolean, generation: number): void {
    node.expanded = expanded;
    node.rowEl.setAttribute("aria-expanded", String(expanded));
    setIcon(node.chevronEl, expanded ? "chevron-down" : "chevron-right");

    if (expanded) {
      if (node.childrenEl) return;
      const children = createDiv({ cls: "pi-tree-children" });
      node.containerEl.appendChild(children);
      node.childrenEl = children;
      this.fillChildren(children, node.path, node.depth + 1, generation);
    } else if (node.childrenEl) {
      this.liveContainers.delete(node.childrenEl);
      node.childrenEl.remove();
      node.childrenEl = null;
    }
  }

  // ---------- sessions ----------

  private runningIdsAt(): Set<string> {
    const r = this.runningIds;
    const ids = typeof r === "function" ? r() : (r ?? []);
    return new Set(ids);
  }

  /** Caller's snapshot, copied and sorted modified DESC (never mutates the
   *  array the caller handed us). */
  private sessionsFor(dirPath: string): SessionInfo[] {
    const sessions = this.getSessions(dirPath).slice();
    sessions.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
    return sessions;
  }

  /** Identical markup to the Recent list rows (same .pi-session-* classes). */
  private appendSessionRow(parent: HTMLElement, session: SessionInfo, runningIds: Set<string>): void {
    const row = parent.createDiv({
      cls: "pi-session-row",
      attr: { tabindex: "0", role: "button" },
    });
    const title = row.createDiv({
      cls: "pi-session-title",
      text: (session.name || session.firstMessage || "(empty)").slice(0, TITLE_MAX_CHARS),
    });
    if (runningIds.has(session.id)) {
      title.createSpan({ cls: "pi-session-running", text: " ●" });
    }
    row.createDiv({
      cls: "pi-session-meta",
      text: `${session.id.slice(0, 8)} · ${formatModified(session.modified)} · ${session.cwd}`,
    });
    activateOn(row, () => this.onOpenSession(session.id));
  }

  // ---------- lazy loading ----------

  /** listDir with cache + in-flight dedupe. Failures are not cached, so the
   *  next expand/refresh retries. */
  private load(path: string, generation: number): Promise<TreeDirEntry[]> {
    const cached = this.cache.get(path);
    if (cached) return Promise.resolve(cached);

    const pending = this.inflight.get(path);
    if (pending) return pending;

    const tracked = this.listDir(path).then(
      (entries) => {
        if (generation === this.generation) this.cache.set(path, entries);
        return entries;
      },
      (err: unknown) => {
        throw err;
      }
    );
    const settled = tracked.finally(() => {
      if (this.inflight.get(path) === settled) this.inflight.delete(path);
    });
    this.inflight.set(path, settled);
    return settled;
  }
}
