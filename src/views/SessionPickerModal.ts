// Session picker: fuzzy-ish list of sessions in a SuggestModal.
// Store-free by design — sessions, running ids, and the open callback are
// injected by the caller (wiring happens elsewhere).

import { App, SuggestModal } from "obsidian";
import type { SessionInfo } from "../api/types";

/** "2025-01-02T03:04:05…" → "2025-01-02 03:04"; falls back to Date, then raw. */
function formatModified(iso: string): string {
  const sliced = iso.slice(0, 16).replace("T", " ");
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(sliced)) return sliced;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class SessionPickerModal extends SuggestModal<SessionInfo> {
  private sessions: SessionInfo[];
  private runningIds: Set<string>;
  // Not named `onOpen` — that clashes with Modal.onOpen().
  private openSession: (sessionId: string) => void;

  constructor(
    app: App,
    sessions: SessionInfo[],
    runningIds: string[],
    onOpen: (sessionId: string) => void
  ) {
    super(app);
    this.sessions = sessions;
    this.runningIds = new Set(runningIds);
    this.openSession = onOpen;
    this.setPlaceholder("Open session…");
  }

  getSuggestions(query: string): SessionInfo[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.sessions;
    // Prefix matches rank ahead of substring matches; input order within each.
    const prefixed: SessionInfo[] = [];
    const contained: SessionInfo[] = [];
    for (const session of this.sessions) {
      const fields = [session.name ?? "", session.firstMessage, session.cwd].map((f) =>
        f.toLowerCase()
      );
      if (fields.some((f) => f.startsWith(q))) prefixed.push(session);
      else if (fields.some((f) => f.includes(q))) contained.push(session);
    }
    return [...prefixed, ...contained];
  }

  renderSuggestion(session: SessionInfo, el: HTMLElement): void {
    const titleEl = el.createDiv();
    titleEl.createSpan({ text: (session.name || session.firstMessage || "(empty)").slice(0, 70) });
    if (this.runningIds.has(session.id)) {
      titleEl.createSpan({ text: " ●", cls: "pi-picker-running" });
    }
    el.createDiv({
      cls: "pi-picker-meta",
      text: `${session.id.slice(0, 8)} · ${formatModified(session.modified)} · ${session.cwd}`,
    });
  }

  onChooseSuggestion(session: SessionInfo): void {
    this.openSession(session.id);
  }
}
