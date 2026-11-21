/**
 * Voice-mode TTS player — speaks an OpenAI-compatible `/v1/audio/speech`
 * endpoint (verified live: piper.halfab.net, JSON `{input, response_format:
 * "wav"}` → `audio/wav` bytes) as a STREAMING utterance pipeline: the store's
 * growing message text is fed through ./speech-chunker's ChunkCursor, whose
 * committed cuts land in ONE global FIFO shared across utterances. Up to
 * MAX_IN_FLIGHT requests synthesize ahead of playback (chunk 0 is simply
 * first in line, so it POSTs first — fast start), and a single
 * HTMLAudioElement plays the FIFO in order for the whole player lifetime —
 * which is what lets AudioAmp tap it exactly once, inside unlock()'s gesture.
 *
 * Browser APIs only (fetch, HTMLAudioElement, URL.createObjectURL) — no
 * Obsidian imports. Sanitizing comes from ./tts-text (applied per chunk at
 * request time); the RIFF guard below is pi-web's bugfix-proven
 * `buildWavHeader` ported from pi-web lib/speak.ts (Buffer → Uint8Array for
 * the webview).
 */
import { AudioAmp } from "./audio-amp";
import { ChunkCursor, type SpeechChunk } from "./speech-chunker";
import { sanitizeForSpeech } from "./tts-text";

export type TtsState = "idle" | "synthesizing" | "playing" | "paused";

export interface TtsPlayerOptions {
  /** OpenAI-compatible speech endpoint, e.g. https://piper.halfab.net/v1/audio/speech */
  url: string;
  onStateChange?: (state: TtsState) => void;
  onError?: (message: string) => void;
  /** Smoothed amplitude 0..1 while audio plays; null when it stops (glow hook). */
  onAmp?: (amp: number | null) => void;
  /** An utterance's audio fully played out (or drained cache-only) — PHASE-19
   *  slot advance. Fires once per utterance; replay passes never fire it. */
  onUtteranceComplete?: (uttId: number) => void;
}

/** One FIFO entry: a single speakable chunk plus its synthesis/playback bookkeeping. */
interface QueuedChunk {
  /** Owning utterance — completion keys off this, replay cache lives per id. */
  uttId: number;
  /** 0-based position within its utterance (error messages only). */
  index: number;
  /** Raw utterance text — sanitized per chunk at request time, not here. */
  text: string;
  /** Object URL once synthesized; null while pending or in flight. */
  url: string | null;
  inFlight: boolean;
  /** Replay chunks borrow the cache's URLs — they never own or release them. */
  replay: boolean;
}

/** Per-utterance bookkeeping: streaming cursor while open, played URLs after. */
interface Utterance {
  id: number;
  /** beginUtterance called, endUtterance not yet — feeds the busy predicate. */
  open: boolean;
  /** At least one chunk dispatched — a begun-but-silent utterance isn't busy. */
  dispatched: boolean;
  /** Skipped (double-tap): synthesis finishes into the replay cache but the
   *  chunks never play and never count as busy (the glow reads idle). */
  muted: boolean;
  /** URLs of chunks that finished playing — becomes the replay cache on completion. */
  playedUrls: string[];
  /** Streaming cursor + latest full text (present only while open). */
  cursor: ChunkCursor | null;
  lastText: string;
  /** Next chunk index within the utterance (diagnostics in error messages). */
  nextIndex: number;
}

/** Replay cache: the last COMPLETED utterance's URLs, replayed without re-synthesis. */
interface ReplayCache {
  id: number;
  urls: string[];
}

/** Max simultaneous synthesis fetches — how far synthesis runs ahead of playback. */
const MAX_IN_FLIGHT = 2;

/**
 * 204-byte 8 kHz mono WAV of pure silence (44-byte header + 320 zero samples)
 * as a data URI — played once by unlock() so iOS/Brave allow later playback.
 */
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class TtsPlayer {
  /** Global chunk FIFO across utterances — synthesis and playback both run in order. */
  private queue: QueuedChunk[] = [];
  /** Synthesis fetches currently running (capped at MAX_IN_FLIGHT). */
  private inflight = 0;
  /** Utterance records still live: open, awaiting their last chunks, or partial. */
  private utterances = new Map<number, Utterance>();
  /** The utterance noteText() feeds right now, if any. */
  private openId: number | null = null;
  private uttSeq = 0;
  /** Last completed utterance's URLs — what replayCurrent() replays. */
  private replayCache: ReplayCache | null = null;
  /** URLs awaiting revocation, deferred while a replay may still load them. */
  private deferredRevoke: string[] = [];

  private state: TtsState = "idle";
  /** Pause HOLD: playback must not (re)start until togglePause() clears it. */
  private pausedHold = false;
  private audio: HTMLAudioElement | null = null;
  /** Object URL currently installed on `audio` (null once released). */
  private currentUrl: string | null = null;
  /** Bumped by every flush so late fetch/event callbacks can't touch new state. */
  private epoch = 0;

  /**
   * Glow amplitude tap — created only when a hook exists, tapped exactly once
   * in unlock()'s gesture. amp.stop() is NEVER called here: it would kill the
   * tap's frame loop for good (the tap cannot be re-created), so silence is
   * expressed via onAmp(null) on state transitions instead.
   */
  private amp: AudioAmp | null;
  /** True once tapElement has run — only then may onAmp fire at all. */
  private ampTapped = false;

  private unlocked = false;
  private unlockInFlight = false;
  private silentAudio: HTMLAudioElement | null = null;

  constructor(private readonly opts: TtsPlayerOptions) {
    this.amp = opts.onAmp ? new AudioAmp({ onAmp: opts.onAmp, gain: 4 }) : null;
  }

  // ── streaming feed ──────────────────────────────────────────────────────

  /** Live pipeline state (0.5.30: the gesture layer reconciles against this
   *  before every dispatch — stale playback flags caused a device bug where
   *  double-tap started a recording over audible playback). */
  get pipelineState(): TtsState {
    return this.state;
  }

  /**
   * Start a new utterance (fresh cursor + id). Safe mid-playback: the FIFO is
   * global, so the previous message's audio keeps playing behind the new one's
   * chunks as the two messages hand over. Returns the utterance id (PHASE-19:
   * the controller tracks it for the display slot).
   */
  beginUtterance(): number {
    // Defensive: a left-open utterance (a missed endUtterance) would wedge the
    // busy predicate forever — close it first, tail included.
    if (this.openId !== null) this.endUtterance();
    const id = ++this.uttSeq;
    this.utterances.set(id, {
      id,
      open: true,
      dispatched: false,
      muted: false,
      playedUrls: [],
      cursor: new ChunkCursor(),
      lastText: "",
      nextIndex: 0,
    });
    this.openId = id;
    // Deliberately no state refresh: zero dispatched chunks isn't busy — a
    // merely-begun utterance must still read as idle until its first cut lands.
    return id;
  }

  /**
   * Feed the utterance's FULL text so far (it grows on every store tick).
   * Unchanged text returns before touching the cursor; changed text yields
   * only newly committed cuts (the cursor tracks its own dispatch offset), so
   * this stays cheap and idempotent either way.
   */
  noteText(text: string): void {
    if (this.openId === null) return; // stray tick — nothing is open
    const utt = this.utterances.get(this.openId);
    const cursor = utt ? utt.cursor : null;
    if (!utt || !cursor) return; // closed between ticks (defensive)
    if (text === utt.lastText) return;
    utt.lastText = text;
    const chunks = cursor.feed(text);
    if (chunks.length > 0) this.appendChunks(utt, chunks);
  }

  /**
   * Close the utterance: the cursor's tail needs the latest full text, which
   * noteText() remembered per utterance — flush it into the FIFO. The
   * utterance completes once its last chunk has played.
   */
  endUtterance(): void {
    if (this.openId === null) return;
    const id = this.openId;
    this.openId = null;
    const utt = this.utterances.get(id);
    if (!utt) return;
    utt.open = false;
    const cursor = utt.cursor;
    utt.cursor = null;
    if (cursor) {
      const tail = cursor.flush(utt.lastText);
      if (tail.length > 0) this.appendChunks(utt, tail);
    }
    // Zero-tail utterance whose chunks already played completes right here.
    this.checkComplete(id);
    this.refreshState(); // an open-but-silent utterance stops counting as busy
  }

  // ── controls ────────────────────────────────────────────────────────────

  /**
   * Pause/resume. Pausing only sets the HOLD — synthesis keeps filling the
   * FIFO, but no playback starts again until the toggle clears it.
   */
  togglePause(): void {
    if (this.state === "playing") {
      // Hold BEFORE pausing so no pump or late fetch can restart audio.
      this.pausedHold = true;
      this.audio?.pause();
      this.setState("paused");
    } else if (this.pausedHold) {
      // Resume: release the hold; the pump restarts the loaded chunk or picks
      // up the head (→ synthesizing when its audio hasn't arrived yet).
      this.pausedHold = false;
      this.pumpPlayback();
      this.refreshState();
    } else if (this.busy()) {
      // Busy but nothing playing (synthesizing): hold so playback won't
      // auto-start; the next toggle clears the hold and lets it run.
      this.pausedHold = true;
      this.setState("paused");
    }
    // idle with nothing queued: no-op.
  }

  /**
   * Re-play the last COMPLETED utterance from its cached URLs — no
   * re-synthesis. Chunks join the FIFO tail (FIFO order: after whatever is
   * already queued) and no-op when no cache exists.
   */
  replayCurrent(): void {
    const cache = this.replayCache;
    if (!cache || cache.urls.length === 0) return;
    // Queued chunks under the cache's id ARE that replay pass (a completed
    // utterance never has ordinary chunks pending) — don't stack a double-tap.
    if (this.queue.some((c) => c.uttId === cache.id)) return;
    for (let i = 0; i < cache.urls.length; i++) {
      this.queue.push({
        uttId: cache.id,
        index: i,
        text: "", // never synthesized again — the URL already exists
        url: cache.urls[i],
        inFlight: false,
        replay: true,
      });
    }
    this.pumpPlayback();
    this.refreshState();
  }

  /**
   * Stop/skip (PHASE-17 double-tap on green): halt audible playback of the
   * current utterance NOW, but let its synthesis finish — the chunks drain
   * into the replay cache (played=true ownership) so a tap-to-repeat is
   * instant. The next queued message starts; nothing left = idle.
   */
  skipCurrent(): void {
    const head = this.queue[0];
    const targetId = head ? head.uttId : this.openId;
    if (targetId === null) return;
    // A skip always advances — the "next message starts" rule owns the hold.
    this.pausedHold = false;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
    }
    this.currentUrl = null;
    const utt = this.utterances.get(targetId);
    if (utt) {
      utt.muted = true;
    } else {
      // Replay pass (no live record): drop its borrowed chunks — the cache
      // owns those URLs; nothing to synthesize, nothing to preserve.
      for (let i = this.queue.length - 1; i >= 0; i--) {
        if (this.queue[i].uttId === targetId) this.removeChunk(this.queue[i], false);
      }
    }
    this.pumpPlayback(); // drains muted chunks → cache, starts the next message
    this.refreshState();
  }

  /**
   * Stop playback, clear the FIFO and the open utterance, back to idle. The
   * replay cache of the last COMPLETED utterance survives — only partial
   * utterances release their audio here.
   */
  stopAndFlush(): void {
    this.epoch++; // every in-flight fetch and event handler becomes a no-op
    this.openId = null;
    for (const utt of this.utterances.values()) {
      this.deferredRevoke.push(...utt.playedUrls);
    }
    this.utterances.clear();
    for (const chunk of this.queue) {
      // Replay URLs belong to the cache, which we keep; everything else is
      // revoked right here (played-or-not, its utterance will never complete).
      if (!chunk.replay && chunk.url !== null) URL.revokeObjectURL(chunk.url);
    }
    this.queue = [];
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
    }
    this.currentUrl = null;
    this.pausedHold = false;
    this.purgeDeferred();
    const wasIdle = this.state === "idle";
    this.setState("idle");
    // setState dedupes — drop the glow explicitly when we were already idle.
    if (wasIdle && this.amp && this.ampTapped) this.opts.onAmp?.(null);
  }

  /**
   * Autoplay unlock for iOS/Brave: play a one-shot silent WAV so later
   * programmatic playback is allowed, then tap the shared audio element for
   * the glow — the tap MUST run inside this same user gesture (iOS), so it
   * happens right here, once, on the one element this player ever uses.
   * Idempotent — a failed attempt can be retried by calling again (ideally
   * from another user gesture).
   */
  unlock(): void {
    if (this.unlocked || this.unlockInFlight) return;
    this.unlockInFlight = true;
    try {
      const silent = new Audio(SILENT_WAV_DATA_URI);
      this.silentAudio = silent;
      silent.play().then(
        () => {
          this.unlockInFlight = false;
          this.unlocked = true;
          silent.onended = () => {
            if (this.silentAudio === silent) this.silentAudio = null;
          };
        },
        () => {
          // Never got a gesture-backed play; allow a later retry.
          this.unlockInFlight = false;
          this.silentAudio = null;
        },
      );
    } catch {
      this.unlockInFlight = false;
      this.silentAudio = null;
    }
    if (this.amp && !this.ampTapped) {
      this.ampTapped = true;
      this.amp.tapElement(this.ensureAudio());
    }
  }

  // ── pipeline ────────────────────────────────────────────────────────────

  /** Append freshly committed chunks to the global FIFO and wake both pumps. */
  private appendChunks(utt: Utterance, chunks: SpeechChunk[]): void {
    for (const chunk of chunks) {
      utt.dispatched = true;
      this.queue.push({
        uttId: utt.id,
        index: utt.nextIndex++,
        text: chunk.text,
        url: null,
        inFlight: false,
        replay: false,
      });
    }
    // Chunk 0 lands first in the FIFO → dispatched first → fast start.
    this.pumpSynthesis();
    this.pumpPlayback();
    this.refreshState(); // first dispatched chunk of an open utterance → synthesizing
  }

  // ── synthesis ───────────────────────────────────────────────────────────

  /**
   * Dispatch fetches for queued chunks in FIFO order, up to the in-flight
   * cap — the implicit prefetch that keeps playback fed (chunk 1 synthesizes
   * while chunk 0 speaks, chunk 2 behind it).
   */
  private pumpSynthesis(): void {
    const pending: QueuedChunk[] = [];
    for (const chunk of this.queue) {
      if (chunk.inFlight || chunk.url !== null) continue;
      pending.push(chunk);
    }
    // Collected first: dispatching may drop an unspeakable chunk synchronously,
    // and that removal must not mutate the list being walked.
    for (const chunk of pending) {
      if (this.inflight >= MAX_IN_FLIGHT) return;
      this.dispatchSynthesis(chunk);
    }
  }

  private dispatchSynthesis(chunk: QueuedChunk): void {
    // Sanitize per chunk AT REQUEST TIME — the cursor chunks the raw text.
    const input = sanitizeForSpeech(chunk.text);
    if (!input) {
      // Nothing speakable survived (e.g. bare markdown): drop it silently — an
      // empty POST would only surface a server error for a chunk of nothing.
      this.removeChunk(chunk, false);
      return;
    }
    chunk.inFlight = true;
    this.inflight++;
    const epoch = this.epoch;
    void synthesizeWav(this.opts.url, input).then(
      (blob) => {
        // Stale (flushed meanwhile): drop the blob before a URL exists — no leak.
        if (epoch === this.epoch) chunk.url = URL.createObjectURL(blob);
        this.settle(chunk, epoch);
      },
      (err: unknown) => {
        if (epoch === this.epoch) {
          this.reportError(errText(err));
          // Drop just this chunk — a failed synthesis must never wedge the FIFO.
          this.removeChunk(chunk, false);
        }
        this.settle(chunk, epoch);
      },
    );
  }

  /** Bookkeeping after a fetch settles: free the slot, re-pump, re-evaluate. */
  private settle(chunk: QueuedChunk, epoch: number): void {
    this.inflight--;
    if (epoch !== this.epoch) return; // flushed meanwhile — leave the new state alone
    this.pumpSynthesis(); // the freed slot may dispatch the next chunk
    this.pumpPlayback(); // the head may have just received its audio
    this.refreshState();
  }

  // ── playback ────────────────────────────────────────────────────────────

  /**
   * Install and start the FIFO head when it has audio. ONE element serves the
   * whole player lifetime (the AudioAmp taps it once), so this never
   * re-creates it — it only loads the next chunk onto the same element.
   */
  private pumpPlayback(): void {
    if (this.pausedHold) return; // synthesis continues; playback waits for a toggle
    const audio = this.ensureAudio();
    if (this.currentUrl !== null) {
      if (!audio.paused) return; // already playing
      this.startPlayback(audio, this.currentUrl); // resume a loaded chunk
      return;
    }
    const head = this.queue[0];
    // Skipped-utterance chunks never play: drain them cache-only and advance.
    // Chunks still synthesizing stay put — pumpPlayback is re-run when their
    // fetch settles (a sub-round-trip delay before the next message starts).
    if (head && head.url !== null && this.chunkMuted(head)) {
      this.removeChunk(head, true); // played=true → URL joins the replay cache
      this.pumpPlayback();
      return;
    }
    if (!head || head.url === null) return; // waiting on synthesis — synthesizing
    this.install(head, audio);
  }

  /** Skipped (muted) chunks belong to an utterance marked skip-to-cache. */
  private chunkMuted(chunk: QueuedChunk): boolean {
    const utt = this.utterances.get(chunk.uttId);
    return utt !== undefined && utt.muted;
  }

  /** Wire the head chunk to the element (event handlers keyed on epoch + URL). */
  private install(chunk: QueuedChunk, audio: HTMLAudioElement): void {
    const url = chunk.url;
    if (url === null) return;
    this.currentUrl = url;
    audio.src = url;
    const epoch = this.epoch;
    const isCurrent = (): boolean => epoch === this.epoch && this.currentUrl === url;
    audio.onended = () => {
      if (!isCurrent()) return;
      this.removeChunk(chunk, true); // → utterance played-URLs → replay cache
      this.pumpPlayback(); // advance to the next chunk
      this.refreshState();
    };
    audio.onerror = () => {
      if (!isCurrent()) return;
      this.removeChunk(chunk, false); // neutralize first — a repeat event can't double-advance
      this.reportError(`Audio playback failed on chunk ${chunk.index + 1}`);
      this.pumpPlayback();
      this.refreshState();
    };
    this.startPlayback(audio, url);
  }

  /** play() with the preserved park-on-failure handling (see below). */
  private startPlayback(audio: HTMLAudioElement, url: string): void {
    const epoch = this.epoch;
    void audio.play().catch((err: unknown) => {
      if (epoch !== this.epoch || this.currentUrl !== url) return; // chunk moved on or was flushed
      if (this.pausedHold) return; // our own pause() interrupted play() — not a failure
      // Autoplay blocked: surface it and take the hold so the next
      // togglePause()/unlock() can start playback without losing the chunk.
      this.reportError(`Playback failed: ${errText(err)}`);
      this.pausedHold = true;
      this.refreshState();
    });
    this.refreshState(); // play() flipped paused synchronously → "playing"
  }

  // ── completion & URL ownership ──────────────────────────────────────────

  /**
   * Remove a chunk from the FIFO and settle its URL ownership: a played chunk
   * hands its URL to the utterance (→ replay cache), an unplayed one is
   * revoked, a replay chunk stays with the cache. Also re-checks completion.
   */
  private removeChunk(chunk: QueuedChunk, played: boolean): void {
    const i = this.queue.indexOf(chunk);
    if (i !== -1) this.queue.splice(i, 1);
    if (chunk.url !== null && this.currentUrl === chunk.url) this.currentUrl = null;
    if (chunk.replay) {
      // Replay chunks borrow the cache's URLs — releasing them is its job.
    } else if (played && chunk.url !== null) {
      const utt = this.utterances.get(chunk.uttId);
      if (utt) utt.playedUrls.push(chunk.url);
      else URL.revokeObjectURL(chunk.url); // defensive: orphaned URL, drop it
    } else if (chunk.url !== null) {
      URL.revokeObjectURL(chunk.url); // synthesized but never finished — no leak
    }
    this.purgeDeferred();
    this.checkComplete(chunk.uttId);
  }

  /**
   * Finalize an utterance once it ended AND fully played — it becomes the
   * replay cache, replacing (and revoking) the older one. A replay pass never
   * reaches here: it has no record, so its borrowed URLs stay with the cache.
   */
  private checkComplete(uttId: number): void {
    const utt = this.utterances.get(uttId);
    if (!utt || utt.open) return; // still streaming — more chunks may come
    if (this.queue.some((c) => c.uttId === uttId)) return; // unplayed chunks remain
    this.utterances.delete(uttId);
    this.opts.onUtteranceComplete?.(uttId); // PHASE-19: slot advance
    // An utterance that never dispatched a chunk (empty message, aborted
    // begin) produced no playback — it must not REPLACE (and wipe) the cache.
    if (!utt.dispatched) return;
    const old = this.replayCache;
    this.replayCache = { id: uttId, urls: utt.playedUrls };
    // Ids are monotonic, so old.id !== uttId holds; the guard keeps a replay
    // re-completion (impossible by construction) from revoking itself.
    if (old && old.id !== uttId) this.deferredRevoke.push(...old.urls);
    this.purgeDeferred();
  }

  /** Revoke deferred URLs once nothing queued still references them — a replay
   *  pass can outlive the cache it borrows from. */
  private purgeDeferred(): void {
    if (this.deferredRevoke.length === 0) return;
    const live = new Set(this.queue.map((c) => c.url));
    const keep: string[] = [];
    for (const url of this.deferredRevoke) {
      if (live.has(url)) keep.push(url);
      else URL.revokeObjectURL(url);
    }
    this.deferredRevoke = keep;
  }

  // ── state ───────────────────────────────────────────────────────────────

  /**
   * The exact predicate behind the glow: element playing > pause hold > busy
   * (synthesizing) > idle. As soon as the first chunk request dispatches the
   * state is synthesizing until audio starts; mid-utterance gaps (all known
   * audio played, waiting for more text) read as synthesizing too.
   */
  private refreshState(): void {
    const audio = this.audio;
    const playing = this.currentUrl !== null && audio !== null && !audio.paused;
    const next: TtsState = playing
      ? "playing"
      : this.pausedHold
        ? "paused"
        : this.busy()
          ? "synthesizing"
          : "idle";
    this.setState(next);
  }

  /** FIFO busy: any non-muted chunk not yet fully played, or an open utterance
   *  that dispatched one. Muted (skipped) background synthesis is NOT busy —
   *  the glow must read idle while it finishes into the cache. */
  private busy(): boolean {
    for (const chunk of this.queue) if (!this.chunkMuted(chunk)) return true;
    if (this.openId === null) return false;
    const utt = this.utterances.get(this.openId);
    return utt !== undefined && utt.dispatched && !utt.muted;
  }

  private setState(state: TtsState): void {
    if (this.state === state) return;
    this.state = state;
    // The glow pins --breath to the live amp only while audio plays; any other
    // state hands it back to the CSS breath. Never fires before the unlock tap.
    if (state !== "playing" && this.amp && this.ampTapped) this.opts.onAmp?.(null);
    this.opts.onStateChange?.(state);
  }

  private reportError(message: string): void {
    this.opts.onError?.(message);
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    return this.audio;
  }
}

// ── fetch + WAV helpers (same style as stt.ts; each file self-contained) ──

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Network/HTTP failures become plain Errors with a human-readable prefix. */
async function request(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`${what}: network error (${errText(err)})`);
  }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  return res;
}

/** POST one chunk to the speech endpoint; returns wav bytes (RIFF-guarded, see below). */
const TTS_PATH = "/v1/audio/speech";

async function synthesizeWav(endpoint: string, text: string): Promise<Blob> {
  // Accept the base URL (settings default) or the full endpoint — stt.ts's
  // normalization pattern. (beta13: posting the bare base gave piper 404s.)
  const url = endpoint.endsWith(TTS_PATH)
    ? endpoint
    : `${endpoint.replace(/\/+$/, "")}${TTS_PATH}`;
  const res = await request(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, response_format: "wav" }),
    },
    "TTS request failed",
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (startsWithRiff(bytes)) return new Blob([bytes], { type: "audio/wav" });
  // RIFF guard (pi-web bugfix-proven): the endpoint handed back raw PCM
  // (s16le, 24 kHz mono) — wrap it in a WAV header or <audio> can't decode it.
  return new Blob([buildWavHeader(bytes.length), bytes], { type: "audio/wav" });
}

function startsWithRiff(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  );
}

/** 44-byte WAV header for raw PCM s16le (24 kHz mono by default) — ported from pi-web lib/speak.ts. */
function buildWavHeader(
  pcmLength: number,
  sampleRate = 24000,
  channels = 1,
  bitsPerSample = 16,
): Uint8Array<ArrayBuffer> {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const view = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcmLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcmLength, true);
  return new Uint8Array(view.buffer);
}
