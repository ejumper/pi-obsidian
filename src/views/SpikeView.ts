// Phase 0 spike view: session list + live plain-text transcript + bare composer.
// Deliberately ugly — proves the pipe end-to-end. Real UI is Phase 1.

import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { openSse, type SseHandle } from "../api/sse";
import type { AgentMessage, AnyAgentFrame, SessionInfo } from "../api/types";
import type PiPlugin from "../main";

export const VIEW_TYPE_PI_SPIKE = "pi-spike";

interface DisplayMessage {
  role: string;
  text: string;
  done: boolean;
}

/** Plain-text projection of a message; null = don't render (system messages). */
function messageToText(msg: AgentMessage): string | null {
  switch (msg.role) {
    case "user":
      return typeof msg.content === "string"
        ? msg.content
        : msg.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
    case "assistant":
      return msg.content
        .map((b) => {
          switch (b.type) {
            case "text":
              return b.text;
            case "thinking":
              return "[thinking]";
            case "toolCall":
              return `[tool: ${b.toolName}]`;
            case "image":
              return "[image]";
          }
        })
        .join("\n");
    case "toolResult":
      return `[result${msg.isError ? " ERROR" : ""}]`;
    case "custom":
      return msg.display ? `[custom: ${msg.customType}]` : null;
    case "system":
      return null;
  }
}

export class SpikeView extends ItemView {
  private currentSessionId: string | null = null;
  private sse: SseHandle | null = null;
  private messages: DisplayMessage[] = [];
  private liveIndex: number | null = null;
  private renderQueued = false;

  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private transcriptEl!: HTMLElement;
  private cwdInputEl!: HTMLInputElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private abortBtnEl!: HTMLButtonElement;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PiPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_PI_SPIKE;
  }

  getDisplayText(): string {
    return this.currentSessionId ? `pi: ${this.currentSessionId.slice(0, 8)}` : "pi spike";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-spike");

    const header = root.createDiv({ cls: "pi-spike-header" });
    header.createEl("span", { text: "cwd:", cls: "pi-spike-label" });
    this.cwdInputEl = header.createEl("input", {
      cls: "pi-spike-cwd",
      type: "text",
      value: "/home/ejumps",
    });
    const refreshBtn = header.createEl("button", { text: "Refresh" });
    refreshBtn.addEventListener("click", () => void this.loadSessions());
    this.statusEl = header.createDiv({ cls: "pi-spike-status", text: "idle" });

    const body = root.createDiv({ cls: "pi-spike-body" });
    this.listEl = body.createDiv({ cls: "pi-spike-list" });
    this.transcriptEl = body.createDiv({ cls: "pi-spike-transcript" });

    const composer = root.createDiv({ cls: "pi-spike-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "pi-spike-input",
      placeholder: "Prompt… (Enter sends, Shift+Enter newline)",
    });
    const row = composer.createDiv({ cls: "pi-spike-composer-row" });
    this.sendBtnEl = row.createEl("button", { text: "Send", cls: "mod-cta" });
    this.abortBtnEl = row.createEl("button", { text: "Abort" });

    this.sendBtnEl.addEventListener("click", () => void this.send());
    this.abortBtnEl.addEventListener("click", () => void this.abort());
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void this.send();
      }
    });

    await this.loadSessions();
  }

  async onClose(): Promise<void> {
    this.sse?.close();
    this.sse = null;
  }

  // ---------- sessions ----------

  private async loadSessions(): Promise<void> {
    try {
      const res = await this.plugin.client.listSessions();
      this.renderSessionList(res.sessions, res.runningSessionIds);
      this.setStatus(`loaded ${res.sessions.length} sessions`);
    } catch (err) {
      this.setStatus(`list failed: ${String(err)}`);
    }
  }

  private renderSessionList(sessions: SessionInfo[], runningIds: string[]): void {
    this.listEl.empty();
    for (const s of sessions.slice(0, 50)) {
      const item = this.listEl.createDiv({ cls: "pi-spike-session" });
      if (runningIds.includes(s.id)) item.addClass("is-running");
      item.createDiv({
        cls: "pi-spike-session-title",
        text: (s.name || s.firstMessage || "(empty)").slice(0, 60),
      });
      item.createDiv({
        cls: "pi-spike-session-meta",
        text: `${s.id.slice(0, 8)} · ${s.modified.slice(0, 16).replace("T", " ")}`,
      });
      item.addEventListener("click", () => void this.openSession(s.id));
    }
  }

  private async openSession(id: string): Promise<void> {
    this.sse?.close();
    this.sse = null;
    this.currentSessionId = id;
    this.messages = [];
    this.liveIndex = null;
    this.render();

    try {
      const detail = await this.plugin.client.getSession(id);
      for (const msg of detail.context.messages) {
        const text = messageToText(msg);
        if (text !== null) this.messages.push({ role: msg.role, text, done: true });
      }
      this.render();
      this.setStatus(`session ${id.slice(0, 8)} loaded (${detail.context.messages.length} msgs)`);
    } catch (err) {
      this.setStatus(`load failed: ${String(err)}`);
      return;
    }

    const url = `${this.plugin.client.baseUrl}/api/agent/${encodeURIComponent(id)}/events`;
    this.sse = openSse(url, {
      onFrame: (_name, data) => this.handleFrame(data),
      onError: (err) => this.setStatus(`stream error: ${err.message}`),
      onClose: () => this.setStatus("stream closed"),
    });
  }

  // ---------- agent events ----------

  private handleFrame(data: unknown): void {
    const ev = data as AnyAgentFrame;
    switch (ev.type) {
      case "connected":
        this.setStatus(`stream connected (${this.currentSessionId?.slice(0, 8)})`);
        break;
      case "message_update": {
        const msg = (ev as { message: AgentMessage }).message;
        this.upsertMessage(msg, false);
        break;
      }
      case "message_end": {
        const msg = (ev as { message: AgentMessage }).message;
        this.upsertMessage(msg, true);
        break;
      }
      case "tool_execution_start": {
        const name = (ev as { toolName?: string }).toolName ?? "?";
        this.appendLine(`→ ${name}`);
        break;
      }
      case "tool_execution_end": {
        const isError = (ev as { isError?: boolean }).isError;
        this.appendLine(isError ? "✗ tool failed" : "✓ tool done");
        break;
      }
      case "agent_start":
        this.setStatus("agent running…");
        break;
      case "agent_end":
        this.setStatus("agent idle");
        break;
      case "prompt_done":
        this.setStatus("prompt done");
        break;
      case "prompt_error": {
        const msg = (ev as { errorMessage?: string }).errorMessage ?? "unknown";
        this.appendLine(`ERROR: ${msg}`);
        break;
      }
      default:
        break; // unknown frames ignored by design
    }
  }

  /** Cumulative snapshots: update the live slot in place; finalize on end. */
  private upsertMessage(msg: AgentMessage, final: boolean): void {
    const text = messageToText(msg);
    if (text === null) return;

    const at = this.liveIndex;
    if (at !== null && this.messages[at]?.role === msg.role) {
      this.messages[at] = { role: msg.role, text, done: final };
      if (final) this.liveIndex = null;
    } else {
      this.messages.push({ role: msg.role, text, done: final });
      this.liveIndex = final ? null : this.messages.length - 1;
    }
    this.scheduleRender();
  }

  private appendLine(line: string): void {
    this.messages.push({ role: "event", text: line, done: true });
    this.scheduleRender();
  }

  // ---------- composer ----------

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.sendBtnEl.disabled = true;
    try {
      if (!this.currentSessionId) {
        const cwd = this.cwdInputEl.value.trim() || "/home/ejumps";
        this.messages.push({ role: "user", text, done: true });
        this.render();
        const { sessionId } = await this.plugin.client.createSession(cwd, text);
        await this.openSession(sessionId);
      } else {
        await this.plugin.client.sendCommand(this.currentSessionId, {
          type: "prompt",
          message: text,
        });
      }
      this.setStatus("prompt sent");
    } catch (err) {
      new Notice(`pi: ${String(err)}`);
      this.setStatus(`send failed: ${String(err)}`);
    } finally {
      this.sendBtnEl.disabled = false;
    }
  }

  private async abort(): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      await this.plugin.client.sendCommand(this.currentSessionId, { type: "abort" });
      this.setStatus("abort sent");
    } catch (err) {
      this.setStatus(`abort failed: ${String(err)}`);
    }
  }

  // ---------- rendering ----------

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    this.transcriptEl.empty();
    for (const m of this.messages) {
      const el = this.transcriptEl.createDiv({
        cls: `pi-spike-msg role-${m.role}${m.done ? "" : " is-live"}`,
      });
      el.createDiv({ cls: "pi-spike-msg-role", text: m.role });
      el.createDiv({ cls: "pi-spike-msg-text", text: m.text });
    }
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private setStatus(text: string): void {
    this.statusEl.setText(text);
    console.log(`[pi-spike] ${text}`);
  }
}
