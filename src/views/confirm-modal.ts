// Destructive-action confirmation. Uses Obsidian's stock modal chrome only
// (`.modal-button` / `.mod-warning` are app styles — no plugin CSS), so it
// looks like every other confirm dialog in the app. Used by the panel's
// session Delete actions (Recent list + Folders tree).

import { App, Modal } from "obsidian";

export class ConfirmModal extends Modal {
  private readonly heading: string;
  private readonly message: string;
  private readonly confirmLabel: string;
  private readonly onConfirm: () => void | Promise<void>;
  /** Re-entry guard: onConfirm may await, and a double-click must not run it
   *  twice before close() lands. */
  private confirming = false;

  constructor(
    app: App,
    title: string,
    message: string,
    confirmLabel: string,
    onConfirm: () => void | Promise<void>
  ) {
    super(app);
    this.heading = title;
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createDiv({ text: this.message });
    const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });
    // Cancel is the default action (focused → Enter cancels); the confirm
    // button carries the standard destructive style.
    const cancel = buttons.createEl("button", { cls: "modal-button", text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const confirm = buttons.createEl("button", {
      cls: "modal-button mod-warning",
      text: this.confirmLabel,
    });
    confirm.addEventListener("click", () => {
      if (this.confirming) return;
      this.confirming = true;
      void (async () => {
        try {
          await this.onConfirm();
        } catch (e) {
          // Callers surface their own Notice — never strand the modal open.
          console.error("[pi-obsidian] confirmed action failed:", e);
        } finally {
          this.close();
        }
      })();
    });
    cancel.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
