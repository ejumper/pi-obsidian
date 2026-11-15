/**
 * Streaming speech chunking (0.5.2) — chunk 0 for a fast start, then the TTS
 * server's chunk_text algorithm ported VERBATIM from /app/server.py on the
 * piper container (CHUNK_MIN 100 / CHUNK_MAX 400 / CHUNK_TAIL_MERGE 40;
 * paragraph break past the minimum → sentence end closest to the max → word
 * gap closest to the max → hard cut; a final scrap under 40 joins the previous
 * chunk). Same function as rss.halfab.net defers to, so the voice mode speaks
 * with the identical rhythm.
 *
 * Streaming model (the one deliberate adaptation): the server's greedy loop
 * only commits a cut once the text runs past it, so cuts are PERMANENTLY
 * stable once produced — the cursor dispatches every committed cut as it
 * appears and holds the open tail until flush (utterance end). Words are
 * therefore spoken exactly once, in order, with no server round-trip index
 * bookkeeping.
 *
 * Chunk 0 (user spec): fires at the first sentence break OR first line break,
 * whichever comes first; past 400 chars with no break it falls back to a word
 * gap (chunk_text's own ladder). Sent as one plain request so playback starts
 * at the first break instead of after the first full chunk.
 *
 * Pure logic — no DOM, no fetch. Covered by test/voice-mode-check.mjs.
 */

const CHUNK_MIN = 100;
const CHUNK_MAX = 400;
const CHUNK_TAIL_MERGE = 40;

/** Server's _SENTENCE_CLOSERS: closing quotes/brackets that ride a sentence end. */
const SENTENCE_CLOSERS = "\"'\u201d\u2019)";

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";
}

/** Server's _sentence_cuts, folded to the last cut in [lo, hi] (it takes max). */
function lastSentenceCut(text: string, lo: number, hi: number): number {
  let best = -1;
  const n = text.length;
  for (let i = Math.max(0, lo - 2); i < Math.min(n, hi); i++) {
    if (".!?".indexOf(text[i]) !== -1) {
      let j = i + 1;
      while (j < n && SENTENCE_CLOSERS.indexOf(text[j]) !== -1) j++;
      if (j >= n) {
        if (j >= lo && j <= hi) best = j; // sentence ends exactly at the text end
      } else if (isSpace(text[j])) {
        let k = j;
        while (k < n && isSpace(text[k])) k++;
        if (k >= lo && k <= hi) best = k; // next chunk starts on a word
      }
    }
  }
  return best;
}

/** Server's _word_cuts, folded to the last cut in [lo, hi] (it takes max). */
function lastWordCut(text: string, lo: number, hi: number): number {
  let best = -1;
  for (let i = Math.max(0, lo - 1); i < Math.min(text.length, hi); i++) {
    if (text[i] === " ") best = i + 1;
  }
  return best;
}

/** First paragraph break (whitespace run with >= 2 newlines) ending in [lo, hi]. */
function firstParaCut(text: string, lo: number, hi: number): number {
  const n = text.length;
  for (let i = Math.max(0, lo - 1); i < Math.min(n, hi); i++) {
    if (text[i] !== "\n") continue;
    // a whitespace run containing >= 2 newlines is a paragraph break
    let j = i;
    let newlines = 0;
    while (j < n && isSpace(text[j])) {
      if (text[j] === "\n") newlines++;
      j++;
    }
    if (newlines >= 2) {
      if (j >= lo && j <= hi) return j;
      return -1; // the break lands past the window — not eligible (server parity)
    }
    i = j - 1; // skip the whole run
  }
  return -1;
}

/**
 * Cut indices for the server's chunk_text on `text` (raw offsets; pieces are
 * the slices between cuts, the tail after the final cut). Committing = the
 * server loop only cuts while the remainder exceeds CHUNK_MAX, so every index
 * returned here is permanent — later text can only append cuts.
 */
export function chunkTextCuts(text: string): number[] {
  const cuts: number[] = [];
  const n = text.length;
  let start = 0;
  while (n - start > CHUNK_MAX) {
    let cut = -1;
    // 1. first paragraph break past the minimum, if within the max
    const p = firstParaCut(text, start + CHUNK_MIN, start + CHUNK_MAX);
    if (p !== -1 && p - start <= CHUNK_MAX) cut = p;
    // 2. sentence end closest to the max
    if (cut === -1) cut = lastSentenceCut(text, start + CHUNK_MIN, start + CHUNK_MAX);
    // 3. word gap closest to the max
    if (cut === -1) cut = lastWordCut(text, start + CHUNK_MIN, start + CHUNK_MAX);
    // 4. pathological unbroken run
    if (cut === -1) cut = start + CHUNK_MAX;
    cuts.push(cut);
    start = cut;
  }
  // a final scrap smaller than the tail-merge minimum joins the previous chunk
  if (cuts.length > 0 && n - start < CHUNK_TAIL_MERGE) cuts.pop();
  return cuts;
}

/**
 * Chunk-0 end offset for the fast-start opener: first sentence break OR first
 * line break, whichever comes first; word-gap fallback past CHUNK_MAX; -1 when
 * nothing has broken yet. (Sentence break = .!?… + closers + whitespace run or
 * text end — the server's sentence rule plus the ellipsis.)
 */
export function findChunk0End(text: string): number {
  const n = text.length;

  let lineEnd = -1;
  const nl = text.indexOf("\n");
  if (nl !== -1) lineEnd = nl + 1;

  let sentEnd = -1;
  for (let i = 0; i < n; i++) {
    if (".!?…".indexOf(text[i]) !== -1) {
      let j = i + 1;
      while (j < n && SENTENCE_CLOSERS.indexOf(text[j]) !== -1) j++;
      if (j >= n) {
        sentEnd = j;
        break;
      }
      if (isSpace(text[j])) {
        let k = j;
        while (k < n && isSpace(text[k])) k++;
        sentEnd = k;
        break;
      }
    }
  }

  if (lineEnd !== -1 && (sentEnd === -1 || lineEnd <= sentEnd)) return lineEnd;
  if (sentEnd !== -1) return sentEnd;
  if (n > CHUNK_MAX) {
    const w = lastWordCut(text, 1, CHUNK_MAX);
    return w !== -1 ? w : CHUNK_MAX;
  }
  return -1;
}

export interface SpeechChunk {
  /** opener = chunk 0 (fast start); body = a committed cut; tail = the flush. */
  kind: "opener" | "body" | "tail";
  text: string;
}

/**
 * One utterance's streaming cursor. feed() the growing text as it streams;
 * it returns chunks to speak NOW (chunk 0, then every committed body cut).
 * flush() at utterance end returns the open tail. Exactly-once by construction:
 * the cursor tracks the raw offset it has dispatched to, so a cut that is
 * dropped by the tail-merge rule and reappears as the tail grows is simply
 * dispatched later — words never repeat or vanish.
 */
export class ChunkCursor {
  /** Absolute offset where the body begins (end of chunk 0); -1 until it fires. */
  private bodyStart = -1;
  /** Absolute offset of the end of the last dispatched region. */
  private sentUpTo = 0;

  feed(text: string): SpeechChunk[] {
    const out: SpeechChunk[] = [];
    if (this.bodyStart === -1) {
      const e = findChunk0End(text);
      if (e <= 0) return out;
      this.bodyStart = e;
      this.sentUpTo = e;
      const t = text.slice(0, e).trim();
      if (t) out.push({ kind: "opener", text: t });
    }
    const cuts = chunkTextCuts(text.slice(this.bodyStart));
    for (const rel of cuts) {
      const c = rel + this.bodyStart;
      if (c > this.sentUpTo) {
        const piece = text.slice(this.sentUpTo, c).trim();
        if (piece) out.push({ kind: "body", text: piece });
        this.sentUpTo = c;
      }
    }
    return out;
  }

  flush(text: string): SpeechChunk[] {
    const out: SpeechChunk[] = [];
    const tail = text.slice(this.sentUpTo).trim();
    if (tail) out.push({ kind: "tail", text: tail });
    this.sentUpTo = text.length;
    return out;
  }
}
