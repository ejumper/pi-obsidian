// Session list for the sidebar panel — pure DOM, no React.
// Store-free by design: the caller passes sessions (already sorted, most
// recent first — this component never sorts), the running ids, and the open
// callback, and places `el` in its own layout. Rename/delete arrive as hooks
// too (this component never touches the API client): rows get an Obsidian
// `Menu` (right-click / long-press) and an inline, file-explorer-style
// rename input.

import { App, Menu, Notice, setIcon } from "obsidian";
import { ConfirmModal } from "../confirm-modal";
import type { SessionInfo } from "../../api/types";

const TITLE_MAX_CHARS = 70;
const SKELETON_ROWS = 5;
/** Long-press → context menu (the touch twin of `contextmenu`). */
const LONG_PRESS_MS = 500;
/** Press drift (px) that cancels the long-press (a scroll/pan, not a press). */
const LONG_PRESS_DRIFT_PX = 10;

/** "2025-01-02T03:04:05…" → "2025-01-02 03:04"; falls back to Date, then raw. */
function formatModified(iso: string): string {
  const sliced = iso.slice(0, 16).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sliced)) return sliced;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Inline, file-explorer-style rename: swap the title's text for an input.
 *  Enter or blur commits (empty/unchanged restores without calling back),
 *  Escape cancels. `row` is flagged `.pi-renaming` so its click/keydown
 *  handlers never activate the session while the input is open. */
function startInlineRename(
  row: HTMLElement,
  title: HTMLElement,
  initial: string,
  onCommit: (name: string) => void
): void {
  if (row.hasClass("pi-renaming")) return;
  row.addClass("pi-renaming");
  const prevHtml = title.innerHTML;
  title.empty();
  const input = title.createEl("input", { cls: "pi-session-rename", value: initial });
  let finished = false;
  const finish = (commit: boolean): void => {
    if (finished) return;
    finished = true;
    const value = input.value.trim();
    title.innerHTML = prevHtml; // restores the exact markup (spinner included)
    row.removeClass("pi-renaming");
    // Ending a rename (blur from a click on the row) must not ALSO open the
    // session: the next press consumes this flag before its click lands.
    row.addClass("pi-rename-just-done");
    if (commit && value && value !== initial) onCommit(value);
  };
  input.addEventListener("keydown", (ev) => {
    ev.stopPropagation(); // never let Enter/Space reach the row's activate handlers
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      finish(false);
    }
  });
  // The input's own clicks/taps must not be read as row activation.
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("dblclick", (ev) => ev.stopPropagation());
  input.addEventListener("contextmenu", (ev) => ev.stopPropagation());
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}

export class SessionList {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly onOpen: (sessionId: string) => void;
  private readonly renameSession: (id: string, name: string) => Promise<void>;
  private readonly deleteSession: (id: string) => Promise<void>;
  private readonly onSessionsChanged: () => void;

  constructor(opts: {
    app: App;
    onOpen: (sessionId: string) => void;
    renameSession: (id: string, name: string) => Promise<void>;
    deleteSession: (id: string) => Promise<void>;
    onSessionsChanged: () => void;
  }) {
    this.app = opts.app;
    this.onOpen = opts.onOpen;
    this.renameSession = opts.renameSession;
    this.deleteSession = opts.deleteSession;
    this.onSessionsChanged = opts.onSessionsChanged;
    this.el = createDiv({ cls: "pi-session-list" });
  }

  /** Placeholder state: pulsing skeleton rows while the list loads. */
  /** id → row/title for in-place marker toggling */
  private rows = new Map<string, { row: HTMLElement; title: HTMLElement }>();

  // ---------- live running markers (0.4.12) ----------

  /** Toggle run markers on existing rows in place — never rebuild the list,
   *  so live run state can't clobber renames, scroll, or the user's place. */
  setRunningIds(ids: Iterable<string>): void {
    const running = new Set(ids);
    for (const [id, entry] of this.rows) {
      if (!entry.row.isConnected) {
        this.rows.delete(id);
        continue;
      }
      this.applyRunning(entry, running.has(id));
    }
  }

  private applyRunning(entry: { row: HTMLElement }, on: boolean): void {
    entry.row.toggleClass("is-running", on);
    const existing = entry.row.querySelector(":scope > .pi-session-running");
    if (on && !existing) {
      const spin = entry.row.createSpan({ cls: "pi-session-running" });
      setIcon(spin, "loader-circle");
    } else if (!on && existing) {
      existing.remove();
    }
  }

  setLoading(): void {
    this.el.empty();
    for (let i = 0; i < SKELETON_ROWS; i++) {
      const row = this.el.createDiv({ cls: "pi-session-row pi-session-skeleton" });
      row.createDiv({ cls: "pi-session-skeleton-bar pi-session-skeleton-title" });
      row.createDiv({ cls: "pi-session-skeleton-bar pi-session-skeleton-meta" });
    }
  }

  setSessions(sessions: SessionInfo[], runningIds: string[]): void {
    this.el.empty();
    this.rows.clear();
    if (sessions.length === 0) {
      this.el.createDiv({ cls: "pi-session-row pi-session-empty", text: "No sessions" });
      return;
    }
    const running = new Set(runningIds);
    for (const session of sessions) {
      const row = this.el.createDiv({
        cls: "pi-session-row",
        attr: { tabindex: "0", role: "button" },
      });
      const display = (session.name || session.firstMessage || "(empty)").slice(0, TITLE_MAX_CHARS);
      const title = row.createDiv({
        cls: "pi-session-title",
        text: display,
      });
      this.rows.set(session.id, { row, title });
      this.applyRunning({ row }, running.has(session.id));
      row.createDiv({
        cls: "pi-session-meta",
        text: `${session.id.slice(0, 8)} · ${formatModified(session.modified)} · ${session.cwd}`,
      });
      this.attachSessionRow(row, title, session, display);
    }
  }

  // ---------- row actions (context menu / inline rename / delete) ----------

  /** Activation + the row's context menu (right-click and long-press), in
   *  one closure so a long-press can suppress the click that follows it. */
  private attachSessionRow(
    row: HTMLElement,
    title: HTMLElement,
    session: SessionInfo,
    display: string
  ): void {
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressAt = { x: 0, y: 0 };
    let longPressed = false;
    const cancelPress = (): void => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    row.addEventListener("click", () => {
      if (longPressed) {
        longPressed = false; // only suppresses the click right after a menu press
        return;
      }
      // Renaming (or the click that just ended the rename) must not open.
      if (row.hasClass("pi-renaming") || row.hasClass("pi-rename-just-done")) return;
      this.onOpen(session.id);
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      if (row.hasClass("pi-renaming")) return;
      ev.preventDefault();
      this.onOpen(session.id);
    });
    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault(); // never the browser's own menu alongside ours
      if (longPressed) return; // the long-press timer just showed ours here
      cancelPress(); // this press opens the menu — don't also fire the timer
      longPressed = true; // and suppress the click that follows it
      this.buildSessionMenu(session, display, row, title).showAtMouseEvent(ev);
    });
    row.addEventListener("pointerdown", (ev) => {
      longPressed = false; // only suppresses the click right after a menu press
      if (row.hasClass("pi-renaming")) return; // editing: no long-press menu
      row.removeClass("pi-rename-just-done"); // consumed by this press's click
      if (ev.button !== 0) return; // primary only — right-click has `contextmenu`
      cancelPress();
      pressAt = { x: ev.clientX, y: ev.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        this.buildSessionMenu(session, display, row, title).showAtPosition(pressAt);
      }, LONG_PRESS_MS);
    });
    row.addEventListener("pointerup", cancelPress);
    row.addEventListener("pointercancel", cancelPress);
    row.addEventListener("pointermove", (ev) => {
      if (!pressTimer) return;
      if (
        Math.abs(ev.clientX - pressAt.x) > LONG_PRESS_DRIFT_PX ||
        Math.abs(ev.clientY - pressAt.y) > LONG_PRESS_DRIFT_PX
      ) {
        cancelPress();
      }
    });
  }

  /** The row's menu — the file explorer's wording/order where it applies. */
  private buildSessionMenu(
    session: SessionInfo,
    display: string,
    row: HTMLElement,
    title: HTMLElement
  ): Menu {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Rename")
        .setIcon("pencil")
        .onClick(() =>
          startInlineRename(
            row,
            title,
            session.name || session.firstMessage || "(empty)",
            (name) => void this.runAndRefresh(this.renameSession(session.id, name), "rename failed")
          )
        )
    );
    menu.addItem((item) =>
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => this.confirmDelete(session, display))
    );
    return menu;
  }

  private confirmDelete(session: SessionInfo, display: string): void {
    new ConfirmModal(
      this.app,
      "Delete session",
      `Delete "${display}"? This cannot be undone.`,
      "Delete",
      () => this.runAndRefresh(this.deleteSession(session.id), "delete failed")
    ).open();
  }

  /** Run a rename/delete, surface failures, then re-list either way — the
   *  panel must end up showing server truth, not our optimistic view. */
  private async runAndRefresh(action: Promise<void>, what: string): Promise<void> {
    try {
      await action;
    } catch (e) {
      new Notice(`pi: ${what} — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.onSessionsChanged();
    }
  }
}
