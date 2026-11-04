// Message renderers: plain DOM + Obsidian's MarkdownRenderer for prose.
// Presentation decisions borrowed from pi-web's components/MessageView.tsx.
//
// renderMessage is re-invoked with cumulative snapshots while streaming — it
// updates the same container in place and skips all work when the message is
// unchanged (WeakMap render key).

import { App, Component, MarkdownRenderer } from "obsidian";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "../../api/types";
import { parseUnifiedPatch, type SplitDiffRow } from "./patch";

export interface RenderOptions {
  streaming?: boolean;
  /** toolCallId → result, for rendering results inside tool-call cards. */
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
}

const MAX_RESULT_LINES = 100;

export class MessageRenderer {
  private renderKeys = new WeakMap<HTMLElement, string>();
  private mdTokens = new WeakMap<HTMLElement, number>();

  constructor(
    private app: App,
    private sourcePath: string,
    private parentComponent: Component
  ) {}

  renderMessage(container: HTMLElement, msg: AgentMessage, opts: RenderOptions = {}): void {
    if (msg.role === "system") return; // pi 1.3 section delta — never render

    const key = `${msg.role}|${opts.streaming ? "s" : "f"}|${JSON.stringify(msg.content)}`;
    if (this.renderKeys.get(container) === key) return;
    this.renderKeys.set(container, key);

    container.empty();
    container.addClass(`pi-msg-${msg.role}`);
    if (opts.streaming) container.addClass("is-streaming");

    switch (msg.role) {
      case "user":
        this.renderUser(container, msg.content);
        break;
      case "assistant":
        this.renderAssistant(container, msg, opts);
        break;
      case "toolResult":
        this.renderStandaloneToolResult(container, msg);
        break;
      case "custom":
        if (msg.display) {
          container.createDiv({ cls: "pi-msg-label", text: msg.customType });
          this.renderTextContent(container, msg.content);
        }
        break;
    }
  }

  // ---------- roles ----------

  private renderUser(container: HTMLElement, content: UserMessage["content"]): void {
    if (typeof content === "string") {
      this.renderMarkdown(container, content);
      return;
    }
    for (const block of content) {
      if (block.type === "text") this.renderMarkdown(container, block.text);
      else container.createDiv({ cls: "pi-msg-placeholder", text: "[image]" });
    }
  }

  private renderAssistant(container: HTMLElement, msg: AssistantMessage, opts: RenderOptions): void {
    for (const block of msg.content) {
      this.renderBlock(container, block, opts);
    }
    if (msg.errorMessage) {
      container.createDiv({ cls: "pi-msg-error", text: `error: ${msg.errorMessage}` });
    }
  }

  private renderBlock(container: HTMLElement, block: AssistantContentBlock, opts: RenderOptions): void {
    switch (block.type) {
      case "text":
        this.renderMarkdown(container, block.text);
        break;
      case "thinking": {
        const text = (block.thinking ?? "").trim();
        if (!text) break; // empty thinking block — render nothing
        const details = container.createEl("details", { cls: "pi-msg-thinking" });
        details.createEl("summary", { text: "thinking" });
        this.renderMarkdown(details.createDiv(), text);
        break;
      }
      case "toolCall":
        this.renderToolCallCard(container, block.toolName, block.toolCallId, block.input,
          opts.toolResults?.get(block.toolCallId), opts.streaming === true);
        break;
      case "image":
        container.createDiv({ cls: "pi-msg-placeholder", text: "[image]" });
        break;
    }
  }

  private renderToolCallCard(
    container: HTMLElement,
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    result: ToolResultMessage | undefined,
    streaming: boolean
  ): void {
    const card = container.createDiv({ cls: "pi-tool-card" });
    const header = card.createDiv({ cls: "pi-tool-header" });
    const glyph = result ? (result.isError ? "✗" : "✓") : (streaming ? "●" : "○");
    header.createSpan({ cls: "pi-tool-glyph", text: glyph });
    header.createSpan({ cls: "pi-tool-name", text: toolName });

    const body = card.createDiv({ cls: "pi-tool-body" });
    const inputText = JSON.stringify(input, null, 2);
    if (inputText && inputText !== "{}") {
      this.renderPre(body, inputText, "pi-tool-input");
    }
    if (result) {
      this.renderToolResultContent(body, result);
    }
    void toolCallId; // id kept for the future card-attached-result path
  }

  private renderStandaloneToolResult(container: HTMLElement, msg: ToolResultMessage): void {
    const row = container.createDiv({ cls: "pi-tool-result" });
    row.createSpan({
      cls: "pi-tool-glyph",
      text: msg.isError ? "✗" : "✓",
    });
    if (msg.toolName) row.createSpan({ cls: "pi-tool-name", text: msg.toolName });
    const body = row.createDiv({ cls: "pi-tool-result-body" });
    this.renderToolResultContent(body, msg);
  }

  private renderToolResultContent(container: HTMLElement, msg: ToolResultMessage): void {
    for (const block of msg.content) {
      if (block.type !== "text") {
        container.createDiv({ cls: "pi-msg-placeholder", text: "[image]" });
        continue;
      }
      const text = block.text ?? "";
      const diff = tryParseDiff(text);
      if (diff) {
        this.renderDiff(container, diff);
      } else {
        this.renderTruncated(container, text);
      }
    }
    if (msg.isError) container.addClass("is-error");
  }

  // ---------- primitives ----------

  private renderTextContent(container: HTMLElement, content: UserMessage["content"]): void {
    if (typeof content === "string") {
      this.renderMarkdown(container, content);
      return;
    }
    for (const block of content) {
      if (block.type === "text") this.renderMarkdown(container, block.text);
      else container.createDiv({ cls: "pi-msg-placeholder", text: "[image]" });
    }
  }

  /** Markdown via Obsidian's renderer. In-place safe under streaming re-render. */
  private renderMarkdown(container: HTMLElement, text: string): void {
    if (!text.trim()) return;
    const token = (this.mdTokens.get(container) ?? 0) + 1;
    this.mdTokens.set(container, token);
    container.empty();
    const target = container.createDiv();
    void MarkdownRenderer.render(this.app, text, target, this.sourcePath, this.parentComponent)
      .then(() => {
        // A newer render replaced this one while we were async — drop the stale output.
        if (this.mdTokens.get(container) !== token) target.remove();
      })
      .catch(() => {
        if (this.mdTokens.get(container) === token) target.setText(text);
      });
  }

  private renderPre(container: HTMLElement, text: string, cls: string): void {
    const pre = container.createEl("pre", { cls });
    pre.createEl("code", { text });
  }

  /** Plain text in a <pre>, truncated past MAX_RESULT_LINES with show-more. */
  private renderTruncated(container: HTMLElement, text: string): void {
    if (!text.trim()) return;
    const lines = text.split("\n");
    if (lines.length <= MAX_RESULT_LINES) {
      this.renderPre(container, text, "pi-tool-text");
      return;
    }
    const shown = lines.slice(0, MAX_RESULT_LINES).join("\n");
    const wrapper = container.createDiv({ cls: "pi-tool-truncated" });
    this.renderPre(wrapper, shown, "pi-tool-text");
    const more = wrapper.createEl("button", {
      cls: "pi-tool-more",
      text: `show ${lines.length - MAX_RESULT_LINES} more lines`,
    });
    more.addEventListener("click", () => {
      wrapper.empty();
      this.renderPre(wrapper, text, "pi-tool-text");
    });
  }

  private renderDiff(container: HTMLElement, rows: SplitDiffRow[]): void {
    const diff = container.createDiv({ cls: "pi-diff" });
    for (const row of rows) {
      if (row.type === "hunk") {
        diff.createDiv({ cls: "pi-diff-hunk", text: row.text });
        continue;
      }
      const line = diff.createDiv({ cls: "pi-diff-line" });
      const left = row.left;
      const right = row.right;
      const renderCell = (cell: typeof left, side: "left" | "right") => {
        const cellEl = line.createDiv({ cls: `pi-diff-cell pi-diff-${cell.type} pi-diff-${side}` });
        cellEl.createSpan({ cls: "pi-diff-no", text: cell.lineNo !== null ? String(cell.lineNo) : "" });
        cellEl.createSpan({ cls: "pi-diff-text", text: cell.text });
      };
      if (left.type !== "empty") renderCell(left, "left");
      if (right.type !== "empty") renderCell(right, "right");
    }
  }
}

/** Unified-diff detection + parse; null when the text isn't a patch. */
function tryParseDiff(text: string): SplitDiffRow[] | null {
  const t = text.trimStart();
  if (!t.startsWith("---") && !t.startsWith("diff --git") && !t.startsWith("@@")) return null;
  const files = parseUnifiedPatch(text);
  if (!files || files.length === 0) return null;
  return files.flatMap((f) => f.rows);
}
