// Session list for the sidebar panel — pure DOM, no React.
// Store-free by design: the caller passes sessions (already sorted, most
// recent first — this component never sorts), the running ids, and the open
// callback, and places `el` in its own layout.

import { setIcon } from "obsidian";
import type { SessionInfo } from "../../api/types";

const TITLE_MAX_CHARS = 70;
const SKELETON_ROWS = 5;

/** "2025-01-02T03:04:05…" → "2025-01-02 03:04"; falls back to Date, then raw. */
function formatModified(iso: string): string {
  const sliced = iso.slice(0, 16).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sliced)) return sliced;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class SessionList {
  readonly el: HTMLElement;
  private readonly onOpen: (sessionId: string) => void;

  constructor(opts: { onOpen: (sessionId: string) => void }) {
    this.onOpen = opts.onOpen;
    this.el = createDiv({ cls: "pi-session-list" });
  }

  /** Placeholder state: pulsing skeleton rows while the list loads. */
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
      const title = row.createDiv({
        cls: "pi-session-title",
        text: (session.name || session.firstMessage || "(empty)").slice(0, TITLE_MAX_CHARS),
      });
      if (running.has(session.id)) {
        const spin = title.createSpan({ cls: "pi-session-running" });
        setIcon(spin, "loader-circle");
        row.addClass("is-running");
      }
      row.createDiv({
        cls: "pi-session-meta",
        text: `${session.id.slice(0, 8)} · ${formatModified(session.modified)} · ${session.cwd}`,
      });
      row.addEventListener("click", () => this.onOpen(session.id));
      row.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        this.onOpen(session.id);
      });
    }
  }
}
