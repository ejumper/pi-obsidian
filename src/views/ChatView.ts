// The chat view: session bar on top, transcript in the middle, composer block
// pinned to the bottom (auto-grow editor + button row). Per PLAN/PHASES/PHASE-2.md.

import { ItemView, Menu, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { AgentStore, type ThinkingLevelOption } from "../state/agent-store";
import type { AgentMessage, AttachedImageInput } from "../api/types";
import { computeTranscriptUnits } from "./message-display";
import { TranscriptRenderer } from "./react/Transcript";
import { AttachmentStage } from "./composer/attachments";
import { buildMentionPrefix, collectOpenFiles, mapServerPaths } from "./composer/mentions";
import { resolveServerPath } from "../state/paths";
import { attachKeyboardInset, composerBottomPx, readKeyboardHeightPx } from "./keyboard";
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
  /** Open inline rename input on the session title (dblclick rename), while
   *  non-null updateTitle() must leave the title alone. */
  private renameInputEl: HTMLInputElement | null = null;
  private barStatusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modelChipEl!: HTMLButtonElement;
  private modelChipNameEl!: HTMLElement;
  private attachBtnEl!: HTMLButtonElement;
  private sendBtnEl!: HTMLButtonElement;
  private queueBtnEl!: HTMLButtonElement;
  private stopBtnEl!: HTMLButtonElement;
  private sendGroupEl!: HTMLElement;
  private runGroupEl!: HTMLElement;
  private transcriptEl!: HTMLElement;

  private pendingCwd: string | null = null;
  /** Mobile composer tab button's count span (null on desktop — no button). */
  private tabCountEl: HTMLElement | null = null;
  /** First openTabOverview() call logs the scan so it can be corrected. */
  private tabOverviewLogged = false;
  private attachments!: AttachmentStage;
  private detachKeyboard: (() => void) | null = null;
  private composerEl!: HTMLElement;
  private barSizeEl!: HTMLElement;
  private queueHostEl!: HTMLElement;
  private geometryTimer: ReturnType<typeof setInterval> | null = null;
  // Scroll-to-bottom bookkeeping: opening/switching a session (or a load
  // settling) must land at the end of the transcript even when the previous
  // scroll position wasn't "near bottom". Prefixed — see the note above.
  private prevSessionIdForScroll: string | null = null;
  private prevLoadingForScroll = false;
  /** Scroll-to-bottom intent window (0.4.6): the old one-shot flag burned
   *  on the first, still-empty render of a session load. While the window is
   *  open every commit and a set of timed passes re-scroll to the end. */
  private pinBottomUntil = 0;
  private prevShownForFocus = false;
  /** The machine this tab talks to (Phase 13) — persisted in leaf state. */
  private instanceId = "";

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

  /** Leaf-state persistence: tabs keep their machine across restarts. */
  getState(): { instanceId: string } {
    return { instanceId: this.instanceId };
  }

  async setState(state: { instanceId?: string } | null): Promise<void> {
    if (state?.instanceId) this.instanceId = state.instanceId;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  /** Re-point this tab at another machine (panel pill): store rebinds and the
   *  tab drops to no-session — sessions are per-machine storage. */
  setInstance(id: string): void {
    if (!id || id === this.instanceId) return;
    this.instanceId = id;
    this.store.rebind(this.plugin.getClient(id));
    this.render();
  }

  private createStore(): AgentStore {
    return new AgentStore(this.plugin.getClient(this.instanceId || undefined), {
      defaultThinkingLevel: this.plugin.settings.defaultThinkingLevel,
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
    // Tool view, not a file view: without this Obsidian's tab/file machinery
    // treats our leaf as "the leaf to navigate in" — the + button and file
    // opens land IN the pi tab (its content shows other tabs' views). Same
    // pattern as graph/kanban views.
    this.navigation = false;
    try {
      // Fresh tabs bind to last-used ?? default machine (Phase 13). Must run
      // before createStore — the store is created against this tab's client.
      if (!this.instanceId) this.instanceId = this.plugin.getInstanceForNewTab().id;
      this.store = this.createStore();
      this.attachments = new AttachmentStage({
        upload: (file) => this.plugin.client.uploadAttachment(file),
        onChange: () => this.updateComposerState(),
      });
      this.buildDom();
      // Tab count follows tab open/close anywhere in the workspace.
      this.registerEvent(
        this.app.workspace.on("layout-change", () => this.updateTabCount())
      );
      // The fixed composer tracks the view rect and hides with the view.
      this.geometryTimer = setInterval(() => {
        const rect = this.contentEl.getBoundingClientRect();
        const shown = this.containerEl.isShown();
        // Visibility transition = the user switched to this pi tab → it is the
        // panel's target now. Only on the edge (false→true) so two pi panes
        // open side by side on desktop never flip-flop.
        if (shown && !this.prevShownForFocus) this.plugin.setActiveChatView(this);
        this.prevShownForFocus = shown;
        this.composerEl.style.display = shown ? "" : "none";
        // CSS pads the composer's bottom only in the mobile closed state
        // (nav-covering takeover) — keep the class in sync every tick.
        this.composerEl.toggleClass("pi-kb-open", readKeyboardHeightPx() > 0);
        if (shown) {
          this.composerEl.style.left = `${Math.round(rect.left)}px`;
          this.composerEl.style.width = `${Math.round(rect.width)}px`;
          this.composerEl.style.bottom = `${composerBottomPx()}px`;
          // The transcript must END at the composer top — the app's box chain
          // doesn't (it runs behind the composer/navbar and pads for the
          // keyboard). Screen geometry again: content height = composer top.
          const composerTop = this.composerEl.getBoundingClientRect().top;
          this.contentEl.style.height =
            `${Math.max(160, Math.round(composerTop - rect.top - 6))}px`;
        }
      }, 250);
      this.transcript = new TranscriptRenderer(this.transcriptEl, {
        app: this.app,
        sourcePath: "",
        component: this,
      });
      void this.plugin.client.getModels().then((models) => {
        this.modelNames = models.models ?? {};
      }).catch(() => {});
      // Panel targeting, interaction signal: whatever pi view the user last
      // touched wins. The composer lives on document.body (outside
      // containerEl) so it needs its own listeners.
      const reportFocus = () => this.plugin.setActiveChatView(this);
      this.registerDomEvent(this.containerEl, "pointerdown", reportFocus);
      this.registerDomEvent(this.containerEl, "focusin", reportFocus);
      this.registerDomEvent(this.composerEl, "pointerdown", reportFocus);
      this.registerDomEvent(this.composerEl, "focusin", reportFocus);
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
    if (this.geometryTimer) clearInterval(this.geometryTimer);
    this.geometryTimer = null;

    this.composerEl?.remove();
    this.transcript?.unmount();
    this.store?.destroy();
  }

  // ---------- DOM ----------

  private buildDom(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("pi-chat");
    // Obsidian pads view content at the bottom (mobile reserves navbar /
    // keyboard room there — the "phantom gap" of the keyboard saga). We own
    // the bottom edge: the composer is screen-fixed and the transcript ends
    // at the composer top, so the app's reserve padding is pure dead space.
    // Zeroing it is what full-height plugin views do (obsidian-chatting does
    // the same). Without this the box ends at the composer but the content
    // box ends one reserve-height early — the blank above the composer.
    root.style.paddingBottom = "0px";

    // Session bar (top): plain title, status, context size.
    const bar = root.createDiv({ cls: "pi-chat-bar" });
    this.sessionTitleEl = bar.createEl("h1", { cls: "pi-chat-title", text: "pi" });
    // Double-click (fires for mobile double-tap too) → rename the open
    // session inline, file-explorer style.
    this.registerDomEvent(this.sessionTitleEl, "dblclick", () => this.beginTitleRename());
    this.barStatusEl = bar.createDiv({ cls: "pi-chat-status" });
    this.barSizeEl = bar.createDiv({ cls: "pi-chat-size" });

    // Transcript (middle).
    this.transcriptEl = root.createDiv({ cls: "pi-chat-transcript" });

    // Composer block: body-attached + fixed (screen geometry — see styles.css).
    const composer = document.body.createDiv({ cls: "pi-chat-composer" });
    this.composerEl = composer;
    // Composer band (0.4.3): [separator line / loading bar] … queued pills …
    // attachment chips … editor … buttons.
    this.queueHostEl = composer.createDiv({ cls: "pi-queue-strip" });
    const chipHost = composer.createDiv({ cls: "pi-attach-host" });
    this.attachments.renderChips(chipHost);
    this.inputEl = composer.createEl("textarea", {
      cls: "pi-chat-input",
      placeholder: Platform.isMobile
        ? "Prompt… (return = newline, send button sends)"
        : "Prompt… (Enter sends, Shift+Enter newline)",
      // textareas default to rows=2 — that intrinsic height would defeat the
      // one-line min-height and become the auto-grow floor
      attr: { rows: "1", enterkeyhint: "enter" },
    });
    this.inputEl.addEventListener("input", () => this.growEditor());
    this.inputEl.addEventListener("keydown", (ev) => {
      // Mobile: the return key inserts a newline (no way to type newlines
      // otherwise) — the send button is the only send path. Desktop keeps the
      // chat convention: Enter sends, Shift+Enter newline. Hardware keyboards
      // on tablets get mobile behavior — accepted tradeoff (Phase 12).
      if (ev.key === "Enter" && !ev.shiftKey && !Platform.isMobile) {
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

    // Left: tab count (mobile only), attach, model chip. The include/exclude
    // mentions toggle lives in the panel's controls row now (T40).
    if (Platform.isMobile) this.buildTabButton(left);
    this.attachBtnEl = this.iconButton(left, "paperclip", "Attach files");
    this.attachBtnEl.addEventListener("click", () => this.attachments.pick());

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

  /** Mobile composer's far-left button: the current root-leaf (tab) count.
   *  Tap → tab overview; long-press → new/close-tab menu. */
  private buildTabButton(parent: HTMLElement): void {
    const btn = parent.createEl("button", {
      cls: "pi-icon-btn pi-tab-btn",
      attr: { "aria-label": "Tabs", title: "Tabs" },
    });
    this.tabCountEl = btn.createSpan({ cls: "pi-tab-count", text: "0" });
    this.updateTabCount();

    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let longPressed = false;
    const cancelPress = (): void => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };

    btn.addEventListener("pointerdown", (ev) => {
      longPressed = false; // only suppresses the click right after a long-press
      cancelPress();
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longPressed = true;
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open new tab").onClick(() => {
            this.app.workspace.getLeaf("tab");
          })
        );
        menu.addItem((item) =>
          item.setTitle("Close current tab").onClick(() => {
            this.app.workspace.activeLeaf?.detach();
          })
        );
        menu.showAtMouseEvent(ev);
      }, 500);
    });
    btn.addEventListener("pointerup", cancelPress);
    btn.addEventListener("pointerleave", cancelPress);
    btn.addEventListener("pointercancel", cancelPress);
    btn.addEventListener("pointermove", cancelPress);
    btn.addEventListener("click", (ev) => {
      if (longPressed) {
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      this.openTabOverview();
    });
  }

  /** Refresh the tab button's count from the workspace's root leaves. */
  private updateTabCount(): void {
    if (!this.tabCountEl) return;
    let n = 0;
    this.app.workspace.iterateRootLeaves(() => {
      n++;
    });
    this.tabCountEl.setText(String(n));
  }

  /** Tap → open the tab overview. The command id depends on which plugin
   *  provides it (unknown at build time), so rank the registry: "tab overview"
   *  / "show-tab-overview" first, then id-"tab" + name-"overview", then any
   *  id containing "tab-overview". First call logs the match + candidates. */
  private openTabOverview(): void {
    type CommandInfo = { id: string; name: string };
    let commands: CommandInfo[] = [];
    try {
      commands =
        ((this.app as any).commands?.listCommands?.() as CommandInfo[] | undefined) ?? [];
    } catch {
      commands = [];
    }
    const has = (s: string, needle: string): boolean => s.toLowerCase().includes(needle);
    const best =
      commands.find(
        (c) =>
          has(c.id, "tab overview") || has(c.name, "tab overview") ||
          has(c.id, "show-tab-overview") || has(c.name, "show-tab-overview")
      ) ??
      commands.find((c) => has(c.id, "tab") && has(c.name, "overview")) ??
      commands.find((c) => has(c.id, "tab-overview"));

    if (!this.tabOverviewLogged) {
      this.tabOverviewLogged = true;
      const tabish = commands.filter((c) => has(c.id, "tab") || has(c.name, "tab"));
      console.log("pi: tab overview match:", best?.id ?? "(none)");
      console.log("pi: tab-ish commands:", tabish);
    }

    if (!best) {
      new Notice("pi: tab overview command not found");
      return;
    }
    (this.app as any).commands.executeCommandById(best.id);
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

  /** Prefix open-file @mentions (pi-web format) when the panel toggle is on
   *  (settings-backed — the panel's controls row owns the write side). */
  private async prependMentions(text: string, cwd: string): Promise<string> {
    if (!this.plugin.settings.includeMentions) return text;
    try {
      const prefix = await resolveServerPath(
        this.plugin.getClient(this.instanceId),
        this.plugin.getInstancePaths(this.instanceId).pathPrefix
      );
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
          cwd = await this.plugin.resolveNewSessionCwd(this.instanceId);
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
    // Soft guard (Phase 13): session storage is per-machine today, so this
    // should never fire — but if storage is ever shared, two machines writing
    // one session file is a hazard worth a warning.
    const clash = this.plugin
      .getChatViews()
      .find(
        (v) =>
          v !== this &&
          v.getInstanceId() !== this.instanceId &&
          v.getStore()?.state.sessionId === id
      );
    if (clash) {
      new Notice("pi: this session is also open on a tab bound to another machine");
    }
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

  /** Session-bar context size — pi-web's AppShell format translated:
   *  "<current>/<max> | <pct>%", k/M abbreviation per pi-web's fmt, and
   *  pi-web's warning thresholds (>70 warn, >90 crit) on theme colors. */
  /** Queued-message pills (0.4.3): full-width pills above the editor, one per
   *  queued steering/follow-up message, each with a down arrow that returns
   *  that message to the editor. */
  private renderQueue(q: { steering?: string[]; followUp?: string[] } | null): void {
    const host = this.queueHostEl;
    host.empty();
    const items: Array<{ kind: "steering" | "followUp"; index: number; text: string }> = [];
    (q?.steering ?? []).forEach((text, index) => items.push({ kind: "steering", index, text }));
    (q?.followUp ?? []).forEach((text, index) => items.push({ kind: "followUp", index, text }));
    for (const item of items) {
      const pill = host.createDiv({ cls: "pi-queue-pill" });
      pill.createDiv({ cls: "pi-queue-text", text: item.text });
      const btn = pill.createEl("button", {
        cls: "pi-queue-recall",
        attr: { "aria-label": "Return to editor", title: "Return to editor" },
      });
      setIcon(btn, "arrow-down");
      btn.addEventListener("click", () => void this.recallQueueItem(item));
    }
  }

  private async recallQueueItem(item: { kind: "steering" | "followUp"; index: number; text: string }): Promise<void> {
    const text = await this.store.recallQueueItem(item.kind, item.index);
    if (text === null) return;
    this.inputEl.value = this.inputEl.value.trim() ? `${this.inputEl.value}\n${text}` : text;
    this.growEditor();
    this.inputEl.focus();
  }

  /** pi-web's composer insertIfEmpty — used by message "edit from here". */
  insertIntoComposer(text: string): void {
    if (this.inputEl.value.trim()) return;
    this.inputEl.value = text;
    this.growEditor();
    this.inputEl.focus();
  }

  private renderContextSize(
    cu: { percent: number | null; contextWindow: number; tokens: number | null } | null
  ): void {
    const el = this.barSizeEl;
    if (!cu?.contextWindow) {
      el.setText("");
      return;
    }
    const fmt = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
    const cur = cu.tokens !== null ? fmt(cu.tokens) : "?";
    const pct = cu.percent !== null ? ` | ${cu.percent.toFixed(0)}%` : "";
    el.setText(`${cur}/${fmt(cu.contextWindow)}${pct}`);
    el.removeClass("pi-ctx-warn", "pi-ctx-crit");
    if (cu.percent !== null && cu.percent > 90) el.addClass("pi-ctx-crit");
    else if (cu.percent !== null && cu.percent > 70) el.addClass("pi-ctx-warn");
  }

  // ---------- rendering ----------

  private render(): void {
    const s = this.store.state;

    this.updateTitle(s.sessionName);
    const tools = s.agentPhase?.kind === "running_tools" ? ` · ${s.agentPhase.tools.map((t) => t.name).join(", ")}` : "";
    // "idle" is the absence of news — only non-idle states earn bar space.
    this.barStatusEl.setText(
      s.loading ? "loading…" :
      s.error ? `error: ${s.error}` :
      s.live ? "live (read-only)" :
      s.isCompacting ? "compacting…" :
      s.agentRunning ? `running${tools}` : ""
    );
    this.renderContextSize(s.contextUsage);
    this.renderQueue(s.queuedMessages);
    // Working indicator: bouncing line on the composer's top border (styles.css).
    this.composerEl.toggleClass("pi-working", s.agentRunning);

    this.modelChipNameEl.setText(
      s.currentModel?.modelId ?? this.plugin.settings.defaultModel?.modelId ?? "model"
    );
    this.updateComposerState();
    this.updateTabCount();

    const stick = this.isNearBottom();

    // Session open/switch: scroll to the end once messages land (loading
    // true→false), and when the session id itself changes. Streaming
    // auto-scroll (the `stick` branch above) is untouched.
    const sessionChanged = this.prevSessionIdForScroll !== s.sessionId;
    const loadSettled = this.prevLoadingForScroll && !s.loading;
    this.prevSessionIdForScroll = s.sessionId;
    this.prevLoadingForScroll = s.loading;
    if (sessionChanged || loadSettled) {
      this.pinBottomUntil = Date.now() + 1400;
      // Timed passes cover growth that happens without React commits (async
      // markdown rendering mutates the DOM directly).
      for (const ms of [150, 400, 800, 1300]) {
        setTimeout(() => {
          if (Date.now() <= this.pinBottomUntil) {
            this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
          }
        }, ms);
      }
    }

    // pi-web's MessageView components render the grouped units (see
    // react/Transcript.tsx + views/message-display.ts).
    this.transcript.update({
      units: computeTranscriptUnits(s.messages, s.agentRunning, s.entryIds),
      streaming: s.streamingMessage,
      modelNames: this.modelNames,
      cwd: s.cwd,
      sessionId: s.sessionId ?? undefined,
      apiBase: this.plugin.getClient(this.instanceId).baseUrl,
      onFork: async (entryId: string) => { const id = await this.store.fork(entryId); if (id) void this.store.openSession(id); return id; },
      onNavigate: (entryId: string) => { void this.store.navigateTo(entryId); },
      onEditContent: (content: string) => this.insertIntoComposer(content),
      onRendered: () => {
        // Fires after React commits — the only moment scrollHeight is real.
        if (Date.now() <= this.pinBottomUntil) {
          this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
        }
      },
    });

    if (stick || sessionChanged || loadSettled) {
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
    // While the inline rename input is open it owns the title — a store
    // update must not stomp it (the input keeps whatever the user typed).
    if (this.renameInputEl) return;
    const s = this.store.state;
    const title =
      s.sessionName ||
      s.firstMessage.slice(0, 60) ||
      (this.pendingCwd ? `new session · ${this.pendingCwd}` : "new session");
    this.sessionTitleEl.setText(name || title);
  }

  /** Title-bar double-click → inline rename of the OPEN session: same input
   *  and Enter/blur/Escape semantics as the panel's session rows; commits via
   *  the store, which renames the active session and updates its own
   *  sessionName (→ render() repaints the new title once the input closes). */
  private beginTitleRename(): void {
    if (this.renameInputEl) return;
    const store = this.store;
    if (!store?.state.sessionId) return; // nothing open to rename
    // Pin the session the rename started for: a session switch under the
    // input must not rename the session that took over the tab.
    const sid = store.state.sessionId;
    const title = this.sessionTitleEl;
    const initial = title.textContent ?? "";
    title.empty();
    const input = title.createEl("input", { cls: "pi-session-rename", value: initial });
    this.renameInputEl = input;
    let finished = false;
    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      const value = input.value.trim();
      this.renameInputEl = null; // updateTitle() may paint again
      title.setText(initial); // restore the old title while the store round-trips
      if (commit && value && value !== initial && store.state.sessionId === sid) {
        void store.renameSession(value);
      }
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
    input.addEventListener("blur", () => finish(true));
    input.focus();
    input.select();
  }
}
