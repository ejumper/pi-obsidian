// The real chat view: top composer (editor + primary button row), transcript
// streaming below, session bar on top. Layout per PLAN/PHASES/PHASE-1.md §0.0.

import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import { AgentStore, type ThinkingLevelOption } from "../state/agent-store";
import type { AgentMessage } from "../api/types";
import { MessageRenderer } from "./render";
import { attachKeyboardInset } from "./keyboard";
import { NewSessionModal } from "./NewSessionModal";
import { SessionPickerModal } from "./SessionPickerModal";
import type PiPlugin from "../main";
import { BUILD_ID } from "../main";

export const VIEW_TYPE_PI_CHAT = "pi-chat";

const THINKING_LEVELS: ThinkingLevelOption[] = [
  "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

export class ChatView extends ItemView {
  private store: AgentStore;
  private renderer: MessageRenderer;
  private unsubscribe: (() => void) | null = null;

  private titleEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtnEl!: HTMLButtonElement;
  private abortBtnEl!: HTMLButtonElement;
  private transcriptEl!: HTMLElement;

  private messageEls: HTMLElement[] = [];
  private renderedMsgs: (AgentMessage | null)[] = [];
  private streamingEl: HTMLElement | null = null;
  private detachKeyboard: (() => void) | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: PiPlugin
  ) {
    super(leaf);
    this.store = new AgentStore(plugin.client, {
      onNotice: (message, type) =>
        new Notice(`pi: ${message}`, type === "error" ? 8000 : 5000),
      onInsertText: (text) => {
        this.inputEl.value = this.inputEl.value
          ? `${this.inputEl.value}\n${text}` : text;
      },
      onSessionRenamed: (_id, name) => this.updateTitle(name),
      onSessionCreated: (info) => {
        this.plugin.settings.lastCwd = info.cwd;
        void this.plugin.saveSettings();
      },
    });
    this.renderer = new MessageRenderer(this.app, "", this);
  }

  getViewType(): string {
    return VIEW_TYPE_PI_CHAT;
  }

  getDisplayText(): string {
    return "pi";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    try {
      this.buildDom();
      this.detachKeyboard = attachKeyboardInset(this.contentEl);
      this.unsubscribe = this.store.subscribe(() => {
        try {
          this.render();
        } catch (e) {
          this.showError(e);
        }
      });
      this.render();
    } catch (e) {
      this.showError(e);
    }
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachKeyboard?.();
    this.detachKeyboard = null;
    this.store.destroy();
  }

  // ---------- DOM ----------

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-chat");

    // Session bar (top): title → picker, new session, model/thinking, status.
    const bar = root.createDiv({ cls: "pi-chat-bar" });
    this.titleEl = bar.createEl("button", { cls: "pi-chat-title", text: "pi" });
    this.titleEl.addEventListener("click", () => void this.openPicker());
    bar.createEl("button", { cls: "pi-chat-new", text: "+" }).addEventListener("click", () =>
      void this.newSession()
    );
    const modelBtn = bar.createEl("button", { cls: "pi-chat-model", text: "model" });
    modelBtn.addEventListener("click", (ev) => void this.openModelMenu(ev));
    this.statusEl = bar.createDiv({ cls: "pi-chat-status", text: "idle" });
    bar.createDiv({
      cls: "pi-chat-version",
      text: `v${this.plugin.manifest.version} (${BUILD_ID})`,
    });

    // Composer block (top, under the bar).
    const composer = root.createDiv({ cls: "pi-chat-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "pi-chat-input",
      placeholder: "Prompt… (Enter sends, Shift+Enter newline)",
    });
    const row = composer.createDiv({ cls: "pi-chat-composer-row" });
    const attachBtn = row.createEl("button", { text: "attach" });
    attachBtn.disabled = true;
    attachBtn.setAttr("title", "File attachments — coming in Phase 2");
    const mentionBtn = row.createEl("button", { text: "include files" });
    mentionBtn.disabled = true;
    mentionBtn.setAttr("title", "Open-file mentions — coming in Phase 2");
    this.abortBtnEl = row.createEl("button", { text: "abort" });
    this.abortBtnEl.style.display = "none";
    this.abortBtnEl.addEventListener("click", () => void this.store.abort());
    this.sendBtnEl = row.createEl("button", { text: "send", cls: "mod-cta" });
    this.sendBtnEl.addEventListener("click", () => void this.sendCurrent());

    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void this.sendCurrent();
      }
    });

    // Transcript (below the composer).
    this.transcriptEl = root.createDiv({ cls: "pi-chat-transcript" });
  }

  // ---------- composer actions ----------

  private async sendCurrent(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const s = this.store.state;

    if (!s.sessionId) {
      const modal = new NewSessionModal(this.app, this.plugin.settings.lastCwd, (cwd, msg) => {
        void this.store.startNewSession(cwd, msg || text);
      });
      modal.setMessage(text);
      modal.open();
      return;
    }

    this.inputEl.value = "";
    if (s.agentRunning) {
      void this.store.steer(text); // Enter = steer while the agent runs
    } else {
      void this.store.sendPrompt(text);
    }
  }

  async newSession(): Promise<void> {
    const modal = new NewSessionModal(this.app, this.plugin.settings.lastCwd, (cwd, msg) => {
      void this.store.startNewSession(cwd, msg);
    });
    modal.open();
  }

  async openPicker(): Promise<void> {
    try {
      const res = await this.plugin.client.listSessions();
      new SessionPickerModal(
        this.app,
        res.sessions,
        res.runningSessionIds,
        (id) => void this.store.openSession(id)
      ).open();
    } catch (e) {
      new Notice(`pi: ${String(e)}`);
    }
  }

  private async openModelMenu(ev: MouseEvent): Promise<void> {
    const s = this.store.state;
    const cwd = s.cwd || this.plugin.settings.lastCwd;
    try {
      const models = await this.plugin.client.getModels(cwd);
      const menu = new Menu();
      for (const m of models.modelList ?? []) {
        menu.addItem((item) =>
          item
            .setTitle(`${m.provider}: ${m.name}`)
            .setChecked(
              s.currentModel?.provider === m.provider && s.currentModel?.modelId === m.id
            )
            .onClick(() => void this.store.setModel(m.provider, m.id))
        );
      }
      menu.addSeparator();
      for (const level of THINKING_LEVELS) {
        menu.addItem((item) =>
          item
            .setTitle(`thinking: ${level}`)
            .setChecked(s.thinkingLevel === level)
            .onClick(() => void this.store.setThinkingLevel(level))
        );
      }
      menu.showAtMouseEvent(ev);
    } catch (e) {
      new Notice(`pi: ${String(e)}`);
    }
  }

  // ---------- commands (called from the command palette / ribbon) ----------

  abortRun(): void {
    void this.store.abort();
  }

  compactNow(): void {
    void this.store.compact();
  }

  cycleThinking(): void {
    const cur = this.store.state.thinkingLevel;
    const next = THINKING_LEVELS[(THINKING_LEVELS.indexOf(cur) + 1) % THINKING_LEVELS.length];
    void this.store.setThinkingLevel(next);
    new Notice(`pi: thinking ${next}`);
  }

  // ---------- rendering ----------

  private render(): void {
    const s = this.store.state;

    this.updateTitle(s.sessionName);
    const tools = s.agentPhase?.kind === "running_tools" ? ` · ${s.agentPhase.tools.map((t) => t.name).join(", ")}` : "";
    this.statusEl.setText(
      s.loading ? "loading…" :
      s.error ? `error: ${s.error}` :
      s.live ? "live (read-only)" :
      s.isCompacting ? "compacting…" :
      s.agentRunning ? `running${tools}` : "idle"
    );

    this.sendBtnEl.setText(s.agentRunning ? "steer" : "send");
    this.abortBtnEl.style.display = s.agentRunning ? "" : "none";

    const stick = this.isNearBottom();
    const msgs = s.messages;

    // Reconcile per-message elements by reference (messages only change identity
    // when appended or replaced by the optimistic-bubble dedupe).
    while (this.messageEls.length > msgs.length) {
      this.messageEls.pop()?.remove();
      this.renderedMsgs.pop();
    }
    for (let i = 0; i < msgs.length; i++) {
      if (this.renderedMsgs[i] === msgs[i]) continue;
      let el = this.messageEls[i];
      if (!el) {
        el = this.transcriptEl.createDiv({ cls: "pi-msg" });
        this.messageEls.push(el);
      }
      this.renderer.renderMessage(el, msgs[i]);
      this.renderedMsgs[i] = msgs[i];
    }

    // Live streaming bubble (cumulative snapshot) at the end.
    if (s.streamingMessage) {
      if (!this.streamingEl) this.streamingEl = this.transcriptEl.createDiv({ cls: "pi-msg is-live" });
      this.renderer.renderMessage(this.streamingEl, s.streamingMessage, { streaming: true });
    } else if (this.streamingEl) {
      this.streamingEl.remove();
      this.streamingEl = null;
    }

    if (stick) this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  private isNearBottom(): boolean {
    const el = this.transcriptEl;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  /** Paint failures INTO the view — a blank pane hides the bug (iOS has no console). */
  private showError(e: unknown): void {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error("pi-obsidian view error:", msg);
    this.contentEl.empty();
    this.contentEl.createEl("pre", { cls: "pi-error-panel" }).setText(
      `pi-obsidian failed to render (v${this.plugin.manifest.version} (${BUILD_ID})):\n\n${msg}`
    );
  }

  private updateTitle(name: string | undefined): void {
    this.titleEl.setText(name || this.store.state.sessionId?.slice(0, 8) || "new session");
  }
}
