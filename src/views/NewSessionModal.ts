// New-session modal: a plain form (no Obsidian Setting API).
// Store-free by design — the default cwd and the create callback are injected
// by the caller (wiring happens elsewhere).

import { App, Modal } from "obsidian";

export class NewSessionModal extends Modal {
  private defaultCwd: string;
  private onCreate: (cwd: string, message: string) => void;

  private cwdInputEl!: HTMLInputElement;
  private messageEl!: HTMLTextAreaElement;
  private errorEl!: HTMLElement;

  constructor(app: App, defaultCwd: string, onCreate: (cwd: string, message: string) => void) {
    super(app);
    this.defaultCwd = defaultCwd;
    this.onCreate = onCreate;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle("New session");

    contentEl.createEl("label", { text: "Working directory" });
    this.cwdInputEl = contentEl.createEl("input", {
      type: "text",
      value: this.defaultCwd,
    });

    contentEl.createEl("label", { text: "First message (optional)" });
    this.messageEl = contentEl.createEl("textarea");
    this.errorEl = contentEl.createDiv();

    // Enter in the cwd field moves on to the message field.
    this.cwdInputEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault();
        this.messageEl.focus();
      }
    });
    // Ctrl/Cmd+Enter submits from anywhere in the modal body.
    contentEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this.submit();
      }
    });
    this.cwdInputEl.addEventListener("input", () => this.errorEl.setText(""));

    const buttons = contentEl.createDiv();
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    buttons
      .createEl("button", { text: "Start", cls: "mod-cta" })
      .addEventListener("click", () => this.submit());

    this.cwdInputEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Prefill the first-message field (e.g. text already typed in the composer). */
  setMessage(text: string): void {
    this.messageEl.value = text;
  }

  private submit(): void {
    const cwd = this.cwdInputEl.value.trim();
    if (!cwd) {
      this.errorEl.setText("Working directory is required.");
      this.cwdInputEl.focus();
      return;
    }
    this.onCreate(cwd, this.messageEl.value.trim());
    this.close();
  }
}
