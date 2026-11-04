// The chat view: session bar on top, transcript in the middle, composer block
// pinned to the bottom (auto-grow editor + button row). Per PLAN/PHASES/PHASE-2.md.

import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
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
  private store!: AgentStore;
  private msgRenderer!: MessageRenderer;
  private unsubscribe: (() => void) | null = null;

  // NOTE: field names must not collide with base-class instance properties —
  // ES2022 class fields are DEFINEd after super() and would clobber values the
  // Obsidian View constructor set (titleEl was exactly this bug: View.load()
  // calls titleEl.setText(getDisplayText()) before onOpen ever runs).
  private sessionTitleEl!: HTMLElement;
  private barStatusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modelChipEl!: HTMLButtonElement;
  private modelChipNameEl!: HTMLElement;
  private attachBtnEl!: HTMLButtonElement;
  private includeBtnEl!: HTMLButtonElement;
  private sendBtnEl!: HTMLButtonElement;
  private queueBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private sendGroupEl!: HTMLElement;
  private runGroupEl!: HTMLElement;
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
    // Construction stays trivial: anything heavier can throw, and a throw in
    // the constructor produces a silently blank leaf (onOpen never runs, so
    // even the error panel never paints). Heavy work happens in onOpen's
    // try/catch instead.
  }

  private createStore(): AgentStore {
    return new AgentStore(this.plugin.client, {
      onNotice: (message, type) =>
        new Notice(`pi: ${message}`, type === "error" ? 8000 : 5000),
      onInsertText: (text) => {
        this.inputEl.value = this.inputEl.value
          ? `${this.inputEl.value}\n${text}` : text;
        this.growEditor();
      },
      onSessionRenamed: (_id, name) => this.updateTitle(name),
      onSessionCreated: (info) => {
        this.plugin.settings.lastCwd = info.cwd;
        void this.plugin.saveSettings();
      },
    });
  }

  async onOpen(): Promise<void> {
    try {
      this.store = this.createStore();
      this.msgRenderer = new MessageRenderer(this.app, "", this);
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

  getViewType(): string {
    return VIEW_TYPE_PI_CHAT;
  }

  getDisplayText(): string {
    return "pi";
  }

  getIcon(): string {
    return "message-square";
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.detachKeyboard?.();
    this.detachKeyboard = null;
    this.store?.destroy();
  }

  // ---------- DOM ----------

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-chat");

    // Session bar (top): plain title, status, version.
    const bar = root.createDiv({ cls: "pi-chat-bar" });
    this.sessionTitleEl = bar.createEl("h1", { cls: "pi-chat-title", text: "pi" });
    this.barStatusEl = bar.createDiv({ cls: "pi-chat-status", text: "idle" });
    bar.createDiv({
      cls: "pi-chat-version",
      text: `v${this.plugin.manifest.version} (${BUILD_ID})`,
    });

    // Transcript (middle).
    this.transcriptEl = root.createDiv({ cls: "pi-chat-transcript" });

    // Composer block (bottom).
    const composer = root.createDiv({ cls: "pi-chat-composer" });
    this.inputEl = composer.createEl("textarea", {
      cls: "pi-chat-input",
      placeholder: "Prompt… (Enter sends, Shift+Enter newline)",
    });
    this.inputEl.addEventListener("input", () => this.growEditor());
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void this.sendCurrent();
      }
    });

    const row = composer.createDiv({ cls: "pi-chat-row" });
    const left = row.createDiv({ cls: "pi-chat-row-left" });
    this.sendGroupEl = row.createDiv({ cls: "pi-chat-row-right" });
    this.runGroupEl = row.createDiv({ cls: "pi-chat-row-right" });

    // Left: attach, include/hide, model chip.
    this.attachBtnEl = this.iconButton(left, "paperclip", "Attach files (coming in Phase 5)");
    this.attachBtnEl.disabled = true;
    this.includeBtnEl = this.iconButton(left, "file", "Include open files in prompt (coming in Phase 5)");
    this.includeBtnEl.disabled = true;

    this.modelChipEl = left.createEl("button", { cls: "pi-model-chip" });
    setIcon(this.modelChipEl.createSpan({ cls: "pi-model-icon" }), "cpu");
    this.modelChipNameEl = this.modelChipEl.createSpan({ cls: "pi-model-name", text: "model" });
    this.modelChipEl.addEventListener("click", (ev) => void this.openModelMenu(ev));

    // Right, idle: send. Right, running: stop + queue.
    this.sendBtnEl = this.iconButton(this.sendGroupEl, "arrow-up", "Send", ["pi-send-btn"]);
    this.sendBtnEl.addEventListener("click", () => void this.sendCurrent());

    this.stopBtnEl = this.runGroupEl.createEl("button", { cls: "pi-stop-btn", text: "Stop" });
    this.stopBtnEl.addEventListener("click", () => void this.store.abort());

    this.queueBtnEl = this.iconButton(this.runGroupEl, "arrow-right", "Queue (steer)", ["pi-queue-btn"]);
    this.queueBtnEl.addEventListener("click", () => void this.sendCurrent());
  }

  private iconButton(
    parent: HTMLElement, icon: string, label: string, extraCls: string[] = []
  ): HTMLButtonElement {
    const btn = parent.createEl("button", {
      cls: ["pi-icon-btn", ...extraCls].join(" "),
      attr: { "aria-label": label, title: label },
    });
    setIcon(btn, icon);
    return btn;
  }

  /** Auto-grow editor: 1 row → grows with content → CSS caps it, then scrolls. */
  private growEditor(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    // +2 for the top/bottom border (height is border-box; scrollHeight isn't).
    el.style.height = `${el.scrollHeight + 2}px`;
    this.updateComposerState();
  }

  private updateComposerState(): void {
    const hasText = this.inputEl.value.trim().length > 0;
    const running = this.store.state.agentRunning;
    this.sendBtnEl.disabled = !hasText;
    this.queueBtnEl.disabled = !hasText;
    this.queueBtnEl.classList.toggle("has-text", hasText);
    this.sendGroupEl.style.display = running ? "none" : "";
    this.runGroupEl.style.display = running ? "" : "none";
  }

  // ---------- composer actions ----------

  private async sendCurrent(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const s = this.store.state;

    if (!s.sessionId) {
      const modal = new NewSessionModal(this.app, this.plugin.settings.lastCwd, (cwd, msg) => {
        void this.store.startNewSession(cwd, msg || text, undefined, {
          model: this.plugin.settings.defaultModel ?? undefined,
        });
      });
      modal.setMessage(text);
      modal.open();
      return;
    }

    this.inputEl.value = "";
    this.growEditor();
    if (s.agentRunning) {
      void this.store.steer(text); // Queue button / Enter while running = steer
    } else {
      void this.store.sendPrompt(text);
    }
  }

  async newSession(): Promise<void> {
    if (!this.store) return;
    const modal = new NewSessionModal(this.app, this.plugin.settings.lastCwd, (cwd, msg) => {
      void this.store.startNewSession(cwd, msg, undefined, {
        model: this.plugin.settings.defaultModel ?? undefined,
      });
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
    if (!this.store) return;
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

  /** Open a session by id (panel-driven). */
  openSessionById(id: string): void {
    if (!this.store) return;
    void this.store.openSession(id);
  }

  /** Store accessor for the pi panel's controls. */
  getStore(): AgentStore | null {
    return this.store ?? null;
  }

  abortRun(): void {
    if (!this.store) return;
    void this.store.abort();
  }

  compactNow(): void {
    if (!this.store) return;
    void this.store.compact();
  }

  cycleThinking(): void {
    if (!this.store) return;
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
    this.barStatusEl.setText(
      s.loading ? "loading…" :
      s.error ? `error: ${s.error}` :
      s.live ? "live (read-only)" :
      s.isCompacting ? "compacting…" :
      s.agentRunning ? `running${tools}` : "idle"
    );

    this.modelChipNameEl.setText(s.currentModel?.modelId ?? "model");
    this.updateComposerState();

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
      this.msgRenderer.renderMessage(el, msgs[i]);
      this.renderedMsgs[i] = msgs[i];
    }

    // Live streaming bubble (cumulative snapshot) at the end.
    if (s.streamingMessage) {
      if (!this.streamingEl) this.streamingEl = this.transcriptEl.createDiv({ cls: "pi-msg is-live" });
      this.msgRenderer.renderMessage(this.streamingEl, s.streamingMessage, { streaming: true });
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
    const s = this.store.state;
    const title = s.sessionName || s.firstMessage.slice(0, 60) || "new session";
    this.sessionTitleEl.setText(name || title);
  }
}
