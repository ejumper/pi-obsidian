/**
 * Voice-mode prompt blocks — the pi-extension prompt-file convention (see
 * ~/.pi/agent/extensions/read-mode/prompts/): the model-facing text lives in .md files next
 * to the code, read at runtime through the vault adapter so it is tunable without a
 * rebuild. The compiled-in copies are only the fallback for a missing/unreadable file
 * (pi-chat-prompt.md pattern).
 */
import enterFallback from "./prompts/voice-enter.md";
import exitFallback from "./prompts/voice-exit.md";

/** Minimal slice of Obsidian's DataAdapter this needs — keeps the loader testable.
 *  mkdir is required for seeding: adapter.write does NOT create parent
 *  directories (0.5.25 lesson — the seed silently failed forever without it). */
export interface VoicePromptReader {
  read(path: string): Promise<string>;
  /** Optional: seeds missing prompt files on first run (BRAT installs only
   *  main.js/manifest/styles — the .md files bootstrap themselves). */
  write?(path: string, data: string): Promise<void>;
  /** Creates a directory; "already exists" errors are ignored by the caller. */
  mkdir?(path: string): Promise<void>;
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

/** Compiled-in copies (esbuild text import), parsed down to model-visible text. */
const ENTER_COMPILED = parsePromptFile(enterFallback, enterFallback.trim());
const EXIT_COMPILED = parsePromptFile(exitFallback, exitFallback.trim());

export async function loadVoicePrompts(
  reader: VoicePromptReader | undefined,
  pluginDir: string | undefined,
): Promise<VoicePrompts> {
  const readOne = async (name: string, compiled: string, raw: string): Promise<string> => {
    if (reader && pluginDir) {
      const path = `${pluginDir}/prompts/${name}`;
      try {
        return parsePromptFile(await reader.read(path), compiled);
      } catch {
        // Missing (BRAT installs only main.js/manifest/styles) — seed it from the
        // compiled copy so the file exists and is tunable on this device.
        try {
          await reader.mkdir?.(`${pluginDir}/prompts`);
        } catch {
          // "already exists" and friends — the write below is the real test
        }
        try {
          await reader.write?.(path, raw);
          console.log(`[pi-obsidian] seeded voice prompt: ${path}`);
        } catch (e) {
          // visible this time — a silently-missing tunable file cost us 0.5.25
          console.warn(`[pi-obsidian] voice prompt seed failed (${path}):`, e);
        }
      }
    }
    return compiled;
  };
  return {
    enter: await readOne("voice-enter.md", ENTER_COMPILED, enterFallback),
    exit: await readOne("voice-exit.md", EXIT_COMPILED, exitFallback),
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
