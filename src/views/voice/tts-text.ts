/**
 * Ported from pi-web lib/tts-text.ts (read-aloud chunking) — keep behavior in sync.
 *
 * Text prep for TTS: strip markdown/code down to speakable plain text, then
 * split into chunks for pipelined playback (small first chunk for fast
 * start, larger chunks after). Only the two functions the voice-mode player
 * needs are ported; node-only pieces (Buffer caches, file reads) stay behind
 * — this runs in a webview.
 */

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const HEADER_RE = /^#{1,6}\s+/gm;
const BOLD_ITALIC_RE = /(\*\*\*|\*\*|\*|___|__|_)([^*_]+)\1/g;
const STRIKETHROUGH_RE = /~~([^~]+)~~/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const BLOCKQUOTE_RE = /^>\s?/gm;
const LIST_MARKER_RE = /^\s*([-*+]|\d+\.)\s+/gm;
const HR_RE = /^[-*_]{3,}\s*$/gm;

/** Strip markdown/code formatting down to plain speakable text. */
export function sanitizeForSpeech(markdown: string): string {
  return markdown
    .replace(CODE_BLOCK_RE, " Skipping over the code block. ")
    .replace(INLINE_CODE_RE, "$1")
    .replace(HEADER_RE, "")
    .replace(LINK_RE, "$1")
    .replace(BOLD_ITALIC_RE, "$2")
    .replace(STRIKETHROUGH_RE, "$1")
    .replace(BLOCKQUOTE_RE, "")
    .replace(LIST_MARKER_RE, "")
    .replace(HR_RE, "")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Chunk 0 targets ~500 chars, breaking at the nearest sentence boundary —
 * not before ~300 chars, and not going far past 500 if avoidable — so
 * playback can start fast. Later chunks stay similarly sized (NOT the much
 * larger ~2000-char chunks read-aloud.sh uses for its own clipboard-reading
 * use case) — measured live against the TTS server: streaming generation
 * holds RTF~0.90x regardless of chunk length (confirmed at both ~75 chars
 * and ~2000 chars), which means generation time scales with chunk length at
 * about the same rate as playback time. A big jump in chunk size (small
 * first chunk, then 2000-char chunks after) would starve the pipeline: the
 * short first chunk's playback time wouldn't cover the much longer next
 * chunk's generation time, producing exactly the large gap this chunking
 * scheme exists to avoid. Keeping chunks uniformly sized keeps generation
 * of chunk N+1 (started when chunk N begins playing) reliably finishing
 * before chunk N's own playback ends.
 */
export function chunkText(
  text: string,
  firstChunkMin = 300,
  firstChunkTarget = 500,
  restChunkMax = 500,
): string[] {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let firstChunk = "";
  let i = 0;
  for (; i < sentences.length; i++) {
    const next = sentences[i];
    const candidate = firstChunk ? `${firstChunk} ${next}` : next;
    if (firstChunk.length >= firstChunkMin && candidate.length > firstChunkTarget) break;
    firstChunk = candidate;
    if (firstChunk.length >= firstChunkTarget) { i++; break; }
  }
  if (firstChunk) chunks.push(firstChunk);

  const rest = sentences.slice(i).join(" ");
  if (rest) {
    const paragraphs = splitParagraphs(rest);
    let buf = "";
    for (const para of paragraphs) {
      const unit = para.length > restChunkMax ? splitSentences(para) : [para];
      for (const piece of unit) {
        if (buf && buf.length + 1 + piece.length > restChunkMax) {
          chunks.push(buf);
          buf = piece;
        } else {
          buf = buf ? `${buf} ${piece}` : piece;
        }
      }
    }
    if (buf) chunks.push(buf);
  }

  return chunks;
}
