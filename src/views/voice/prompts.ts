/**
 * Voice-mode prompt blocks — the pi-extension prompt-file convention (see
 * ~/.pi/agent/extensions/read-mode/prompts/): the model-facing text lives in .md files next
 * to the code, read at runtime through the vault adapter so it is tunable without a
 * rebuild. The compiled-in copies are only the fallback for a missing/unreadable file
 * (pi-chat-prompt.md pattern).
 */
import enterFallback from "./prompts/voice-enter.md";
import exitFallback from "./prompts/voice-exit.md";

/** Minimal slice of Obsidian's DataAdapter this needs — keeps the loader testable. */
export interface VoicePromptReader {
  read(path: string): Promise<string>;
}

export interface VoicePrompts {
  enter: string;
  exit: string;
}

/** Everything after the first line that is exactly `---` is model-visible. */
export function parsePromptFile(raw: string, fallback: string): string {
  const text = raw ?? "";
  const marker = text.indexOf("\n---\n");
  const body = marker >= 0 ? text.slice(marker + "\n---\n".length) : text;
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export async function loadVoicePrompts(
  reader: VoicePromptReader | undefined,
  pluginDir: string | undefined,
): Promise<VoicePrompts> {
  const readOne = async (name: string, fallback: string): Promise<string> => {
    if (reader && pluginDir) {
      try {
        return parsePromptFile(await reader.read(`${pluginDir}/prompts/${name}`), fallback);
      } catch {
        // missing file or unreadable — compiled fallback
      }
    }
    return fallback;
  };
  return {
    enter: await readOne("voice-enter.md", enterFallback.trim()),
    exit: await readOne("voice-exit.md", exitFallback.trim()),
  };
}

/**
 * The banner rides in-band at the top of the outgoing prompt text (the harness has no
 * per-message system channel; read-mode's `display: false` injection is not reachable from
 * outside). The `<voice-mode>` wrapper is load-bearing: it is what identifies the block as
 * harness content rather than user words, and the render layer strips it (banner is
 * invisible by design — pi's read-mode reference).
 */
export function wrapVoiceBlock(body: string, promptText: string): string {
  return `${body.trim()}\n\n${promptText}`;
}
