// The chat view: session bar on top, transcript in the middle, composer block
// pinned to the bottom (auto-grow editor + button row). Per PLAN/PHASES/PHASE-2.md.

import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { AgentStore, type ThinkingLevelOption } from "../state/agent-store";
import type { AgentMessage, AttachedImageInput } from "../api/types";
import { computeTranscriptUnits } from "./message-display";
import { TranscriptRenderer } from "./react/Transcript";
import { AttachmentStage } from "./composer/attachments";
import { buildMentionPrefix, collectOpenFiles, mapServerPaths } from "./composer/mentions";
import { resolveServerPath } from "../state/paths";
import { attachKeyboardInset } from "./keyboard";
import { formatTelemetry, readTelemetry } from "./telemetry";
import type PiPlugin from "../main";
import { BUILD_ID } from "../main";

export const VIEW_TYPE_PI_CHAT = "pi-chat";

const THINKING_LEVELS: ThinkingLevelOption[] = [
  "auto", "off", "minimal", "low", "medium", "high", "xhigh", "max",
];

export class ChatView extends ItemView {
  private store!: AgentStore;
  private transcript!: TranscriptRenderer;
  private modelNames: Record<string, string> = {};
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

  private pendingCwd: string | null = null;
  /** Include open-file @mentions in outgoing prompts (settings-backed). */
  private includeFiles = false;
  private attachments!: AttachmentStage;
  private detachKeyboard: (() => void) | null = null;
  private telemetryEl: HTMLElement | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;

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
      this.includeFiles = this.plugin.settings.includeMentions;
      this.attachments = new AttachmentStage({
        upload: (file) => this.plugin.client.uploadAttachment(file),
        onChange: () => this.updateComposerState(),
      });
      this.buildDom();
      document.body.classList.toggle(
        "pi-no-keyboard-inset",
        this.plugin.settings.keyboardInsetMode === "none"
      );
      if (this.plugin.settings.keyboardDebug) {
        this.telemetryEl = this.contentEl.createDiv({ cls: "pi-kb-debug" });
        this.telemetryTimer = setInterval(() => {
          if (this.telemetryEl) {
            this.telemetryEl.setText(
              formatTelemetry(readTelemetry(this.contentEl, this.inputEl))
            );
          }
        }, 500);
      }
      this.transcript = new TranscriptRenderer(this.transcriptEl, {
        app: this.app,
        sourcePath: "",
        component: this,
      });
      void this.plugin.client.getModels().then((models) => {
        this.modelNames = models.models ?? {};
      }).catch(() => {});
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
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = null;
    this.telemetryEl = null;
    this.transcript?.unmount();
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
      // textareas default to rows=2 — that intrinsic height would defeat the
      // one-line min-height and become the auto-grow floor
      attr: { rows: "1" },
    });
    // Staged attachment chips, right under the editor (pi-web placement).
    const chipHost = composer.createDiv({ cls: "pi-attach-host" });
    this.attachments.renderChips(chipHost);

    this.inputEl.addEventListener("input", () => this.growEditor());
    this.inputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        void this.sendCurrent();
      }
    });
    // Paste and drop files into the composer (pi-web parity).
    this.inputEl.addEventListener("paste", (ev) => {
      const files = ev.clipboardData?.files;
      if (files && files.length > 0) {
        ev.preventDefault();
        this.attachments.addFiles(files);
      }
    });

    const row = composer.createDiv({ cls: "pi-chat-row" });
    const left = row.createDiv({ cls: "pi-chat-row-left" });
    this.sendGroupEl = row.createDiv({ cls: "pi-chat-row-right" });
    this.runGroupEl = row.createDiv({ cls: "pi-chat-row-right" });

    // Left: attach, include/hide, model chip.
    this.attachBtnEl = this.iconButton(left, "paperclip", "Attach files");
    this.attachBtnEl.addEventListener("click", () => this.attachments.pick());
    this.includeBtnEl = this.iconButton(left, "file", "Include open files in prompt");
    this.includeBtnEl.addEventListener("click", () => {
      this.includeFiles = !this.includeFiles;
      this.plugin.settings.includeMentions = this.includeFiles;
      void this.plugin.saveSettings();
      this.updateComposerState();
    });

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

    // Include/hide state + badge of files that would be mentioned.
    setIcon(this.includeBtnEl, this.includeFiles ? "file" : "file-x");
    const count = this.includeFiles ? collectOpenFiles(this.app).length : 0;
    if (count > 0) this.includeBtnEl.setAttribute("data-badge", String(count));
    else this.includeBtnEl.removeAttribute("data-badge");
    this.includeBtnEl.setAttribute(
      "title",
      this.includeFiles ? `Include ${count} open file(s) in prompt` : "Open-file mentions excluded"
    );
  }

  /** Prefix open-file @mentions (pi-web format) when the toggle is on. */
  private async prependMentions(text: string, cwd: string): Promise<string> {
    if (!this.includeFiles) return text;
    try {
      const prefix = await resolveServerPath(this.plugin.client, this.plugin.settings.pathPrefix);
      const files = mapServerPaths(collectOpenFiles(this.app), prefix);
      const lines = buildMentionPrefix(files, cwd);
      if (lines.length === 0) return text;
      return `${lines.join("\n")}\n${text}`;
    } catch (e) {
      new Notice(`pi: mentions failed — ${String(e)}`);
      return text;
    }
  }

  // ---------- composer actions ----------

  private async sendCurrent(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const s = this.store.state;

    // pi-web parity: never queue mid-run with staged attachments.
    if (s.agentRunning && this.attachments.staged.length > 0) {
      new Notice("pi: attachments can't be queued while a run is active — send or clear them first");
      return;
    }

    // Stage everything BEFORE clearing the editor so failures keep the draft.
    let prepared: { images: AttachedImageInput[]; prefixLines: string[] };
    try {
      prepared = await this.attachments.prepareSend();
    } catch (e) {
      new Notice(`pi: ${String(e)}`);
      return;
    }
    const withFileLines = (t: string): string =>
      prepared.prefixLines.length ? `${prepared.prefixLines.join("\n")}\n${t}` : t;
    const images = prepared.images.length ? prepared.images : undefined;

    if (!s.sessionId) {
      let cwd = this.pendingCwd;
      if (!cwd) {
        try {
          cwd = await this.plugin.resolveNewSessionCwd();
        } catch {
          // chain resolution failed — fall back to the explicit-cwd modal
        }
      }
      if (cwd) {
        const finalText = withFileLines(await this.prependMentions(text, cwd));
        this.pendingCwd = null;
        this.inputEl.value = "";
        this.growEditor();
        void this.store.startNewSession(cwd, finalText, images, {
          model: this.plugin.settings.defaultModel ?? undefined,
        });
        return;
      }
      new Notice("pi: could not resolve a working directory for a new session");
      return;
    }

    const finalText = withFileLines(await this.prependMentions(text, s.cwd));
    this.inputEl.value = "";
    this.growEditor();
    if (s.agentRunning) {
      void this.store.steer(finalText, images); // Queue button / Enter while running = steer
    } else {
      void this.store.sendPrompt(finalText, images);
    }
  }

  /** Prepare a new session at the given cwd (no modal); first prompt creates it. */
  prepareNewSession(cwd: string): void {
    if (!this.store) return;
    this.pendingCwd = cwd;
    this.store.reset();
    this.updateTitle(undefined);
    this.inputEl.focus();
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

    // pi-web's MessageView components render the grouped units (see
    // react/Transcript.tsx + views/message-display.ts).
    this.transcript.update({
      units: computeTranscriptUnits(s.messages, s.agentRunning, s.entryIds),
      streaming: s.streamingMessage,
      modelNames: this.modelNames,
      cwd: s.cwd,
      sessionId: s.sessionId ?? undefined,
    });

    if (stick) {
      requestAnimationFrame(() => {
        this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
      });
    }
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
    const title =
      s.sessionName ||
      s.firstMessage.slice(0, 60) ||
      (this.pendingCwd ? `new session · ${this.pendingCwd}` : "new session");
    this.sessionTitleEl.setText(name || title);
  }
}
