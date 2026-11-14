/**
 * Voice-mode banner state machine (PHASE-14 §1.1) — mirrors pi's read-mode extension
 * (~/.pi/agent/extensions/read-mode/): the mode is announced by an in-band `<voice-mode>`
 * block riding the prompt text, once per state change, and each block declares itself
 * active until another block states otherwise.
 *
 * Pure: no Obsidian, no DOM. `mode` is the UI toggle; `announced` is recovered from the
 * session transcript (blocks live in prompt text, so the transcript is self-describing and
 * survives crashes); `bannerVerified` says the last banner sent is verifiably still in the
 * model's context — it is cleared on session/store rebind and on detected compaction, which
 * re-announces with the loud enter block instead of riding every prompt (user decision:
 * TTS instructions are not a serious enough gate for a per-prompt hold line).
 */

import type { AgentMessage } from "../../api/types";

export type VoiceMode = "voice" | "normal";

/** What block (if any) the next outgoing prompt must carry. "reenter" uses the enter text. */
export type BannerAction = "enter" | "exit" | "reenter" | null;

export function decideBanner(
  mode: VoiceMode,
  announced: VoiceMode | null,
  bannerVerified: boolean,
): BannerAction {
  if (mode !== announced) {
    // No block in the transcript yet: normal mode is the silent default.
    if (announced === null && mode === "normal") return null;
    return mode === "voice" ? "enter" : "exit";
  }
  if (mode === "voice" && !bannerVerified) return "reenter";
  return null;
}

const BLOCK_RE = /<voice-mode>([\s\S]*?)<\/voice-mode>/g;

/** Body of the first `<voice-mode>` block in the message, or null. */
export function parseVoiceBlock(text: string): string | null {
  const m = /<voice-mode>([\s\S]*?)<\/voice-mode>/.exec(text);
  return m ? m[1].trim() : null;
}

/** The last block seen across the transcript decides `announced`. */
export function recoverAnnounced(messages: string[]): VoiceMode | null {
  let announced: VoiceMode | null = null;
  for (const text of messages) {
    for (const m of text.matchAll(BLOCK_RE)) {
      announced = /VOICE MODE IS OFF/i.test(m[1]) ? "normal" : "voice";
    }
  }
  return announced;
}

/** Display/copy layer: strip blocks from a message. Plain text passes through untouched. */
export function stripVoiceBlocks(text: string): string {
  if (!text.includes("<voice-mode>")) return text;
  return text.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Message-shaped strip for the render choke point: display AND copy actions both derive
 * from the same blocks, so stripping here makes the banner invisible everywhere (the
 * banner rides user message text in-band — pi's read-mode reference renders it
 * `display: false`; we cannot, so the render layer drops it). Handles both user-message
 * shapes (plain string content and block arrays).
 */
export function stripMessageVoiceBlocks(msg: AgentMessage): AgentMessage {
  switch (msg.role) {
    case "user":
    case "custom": {
      if (typeof msg.content === "string") {
        return msg.content.includes("<voice-mode>")
          ? { ...msg, content: stripVoiceBlocks(msg.content) }
          : msg;
      }
      let changed = false;
      const content = msg.content.map((block) => {
        if (block.type === "text" && block.text.includes("<voice-mode>")) {
          changed = true;
          return { ...block, text: stripVoiceBlocks(block.text) };
        }
        return block;
      });
      return changed ? { ...msg, content } : msg;
    }
    case "assistant": {
      let changed = false;
      const content = msg.content.map((block) => {
        if (block.type === "text" && block.text.includes("<voice-mode>")) {
          changed = true;
          return { ...block, text: stripVoiceBlocks(block.text) };
        }
        return block;
      });
      return changed ? { ...msg, content } : msg;
    }
    default:
      return msg;
  }
}
