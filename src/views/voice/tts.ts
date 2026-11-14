/**
 * Voice-mode TTS player — speaks an OpenAI-compatible `/v1/audio/speech`
 * endpoint (verified live: piper.halfab.net, JSON `{input, response_format:
 * "wav"}` → `audio/wav` bytes) with lazy per-chunk synthesis: chunk 0 POSTs
 * as soon as its unit is enqueued, chunk N+1 prefetches while N plays.
 *
 * Browser APIs only (fetch, HTMLAudioElement, URL.createObjectURL) — no
 * Obsidian imports. Chunking/sanitizing comes from ./tts-text (ported from
 * pi-web); the RIFF guard below is pi-web's bugfix-proven `buildWavHeader`
 * ported from pi-web lib/speak.ts (Buffer → Uint8Array for the webview).
 */
import { chunkText, sanitizeForSpeech } from "./tts-text";

export type TtsState = "idle" | "synthesizing" | "playing" | "paused";

export interface TtsPlayerOptions {
  /** OpenAI-compatible speech endpoint, e.g. https://piper.halfab.net/v1/audio/speech */
  url: string;
  onStateChange?: (state: TtsState) => void;
  onError?: (message: string) => void;
}

/** One queued message unit: all its chunks play in order; replayCurrent() replays it whole. */
type Unit = string[];

/** In-flight/completed prefetch of the next chunk of the current unit. */
interface PrefetchSlot {
  index: number;
  /** Resolves to an object URL, or null when synthesis failed or went stale. */
  promise: Promise<string | null>;
}

/**
 * 204-byte 8 kHz mono WAV of pure silence (44-byte header + 320 zero samples)
 * as a data URI — played once by unlock() so iOS/Brave allow later playback.
 */
const SILENT_WAV_DATA_URI =
  "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export class TtsPlayer {
  /** Units waiting behind the current one. */
  private units: Unit[] = [];
  /** The unit currently playing (chunks consumed left to right), if any. */
  private current: Unit | null = null;
  /** Most recently enqueued unit — what replayCurrent() replays. */
  private lastUnit: Unit | null = null;

  private state: TtsState = "idle";
  private audio: HTMLAudioElement | null = null;
  /** Object URL currently installed on `audio` (null once released). */
  private audioUrl: string | null = null;
  private prefetch: PrefetchSlot | null = null;
  /** Bumped by every halt so late fetch/event callbacks can't touch new state. */
  private epoch = 0;

  private unlocked = false;
  private unlockInFlight = false;
  private silentAudio: HTMLAudioElement | null = null;

  constructor(private readonly opts: TtsPlayerOptions) {}

  /**
   * Queue `text` as ONE message unit: sanitized + chunked, all chunks play in
   * order behind whatever is already queued. Synthesis itself stays lazy —
   * nothing is POSTed until the chunk's playback slot approaches.
   */
  enqueue(text: string): void {
    const chunks = chunkText(sanitizeForSpeech(text));
    if (chunks.length === 0) return;
    this.lastUnit = chunks;
    this.units.push(chunks);
    this.pump();
  }

  /** Pause/resume the current playback. Pausing during synthesis defers the chunk until resume. */
  togglePause(): void {
    if (this.state === "playing") {
      this.audio?.pause();
      this.setState("paused");
    } else if (this.state === "paused") {
      this.setState("playing");
      const url = this.audioUrl;
      const audio = this.audio;
      if (audio && url) {
        void audio.play().catch((err: unknown) => {
          if (this.audioUrl !== url) return; // chunk moved on or was flushed meanwhile
          this.reportError(`Playback failed: ${errText(err)}`);
          this.setState("paused");
        });
      }
      // else: still synthesizing — playChunk() starts it when the chunk arrives.
    } else if (this.state === "synthesizing") {
      this.setState("paused");
    }
  }

  /** Replay the last enqueued message unit from its first chunk (pending units queue behind it). */
  replayCurrent(): void {
    const unit = this.lastUnit;
    if (!unit || unit.length === 0) return;
    this.haltPlayback();
    this.units = this.units.filter((u) => u !== unit);
    this.units.unshift(unit);
    this.setState("idle");
    this.pump();
  }

  /** Stop playback, clear all pending chunks/units, revoke URLs, back to idle. */
  stopAndFlush(): void {
    this.units = [];
    this.haltPlayback();
    this.setState("idle");
  }

  /**
   * Autoplay unlock for iOS/Brave: play a one-shot silent WAV so later
   * programmatic playback is allowed. Idempotent — a failed attempt can be
   * retried by calling again (ideally from another user gesture).
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
  }

  // ── pipeline ────────────────────────────────────────────────────────────

  /** Dequeue the next unit when nothing is playing. */
  private pump(): void {
    if (this.current) return;
    const next = this.units.shift();
    if (!next) {
      this.setState("idle");
      return;
    }
    this.current = next;
    void this.playChunk(0);
  }

  private async playChunk(index: number): Promise<void> {
    const unit = this.current;
    if (!unit) return;
    if (index >= unit.length) {
      this.current = null;
      this.pump();
      return;
    }
    const epoch = this.epoch;

    const url = await this.obtainChunkUrl(unit, index, epoch);
    if (epoch !== this.epoch) {
      if (url !== null) URL.revokeObjectURL(url);
      return;
    }
    if (url === null) {
      // Failure already reported (or chunk superseded) — skip and continue.
      void this.playChunk(index + 1);
      return;
    }

    // Install on the shared audio element, releasing the outgoing URL if any.
    const audio = this.ensureAudio();
    if (this.audioUrl !== null) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = url;
    audio.src = url;

    const isCurrent = (): boolean => epoch === this.epoch && this.audioUrl === url;
    audio.onended = () => {
      if (!isCurrent()) return;
      this.releaseUrl(url);
      void this.playChunk(index + 1);
    };
    audio.onerror = () => {
      if (!isCurrent()) return;
      this.releaseUrl(url); // neutralize first — a repeat event can't double-advance
      this.reportError(`Audio playback failed on chunk ${index + 1}`);
      void this.playChunk(index + 1);
    };

    // Prefetch chunk N+1 while N plays (within-unit only; one slot deep).
    this.prefetchChunk(unit, index + 1, epoch);

    if (this.state === "paused") return; // install only — togglePause() starts it later
    this.setState("playing");
    try {
      await audio.play();
    } catch (err) {
      if (!isCurrent()) return;
      // Autoplay blocked (or interrupted): surface it and park in "paused" so
      // the next togglePause()/unlock() can start playback without losing state.
      this.reportError(`Playback failed: ${errText(err)}`);
      this.setState("paused");
    }
  }

  /**
   * Resolve this chunk's object URL: consume the prefetch made while the
   * previous chunk played, or synthesize now (the slot has approached).
   * Returns null on failure (already reported via onError) or when the epoch
   * moved on (stale — nothing to report).
   */
  private async obtainChunkUrl(unit: Unit, index: number, epoch: number): Promise<string | null> {
    if (this.prefetch && this.prefetch.index === index) {
      const slot = this.prefetch;
      this.prefetch = null;
      const url = await slot.promise;
      if (epoch !== this.epoch) {
        if (url !== null) URL.revokeObjectURL(url);
        return null;
      }
      return url;
    }
    if (this.state !== "paused") this.setState("synthesizing");
    let blob: Blob;
    try {
      blob = await synthesizeWav(this.opts.url, unit[index]);
    } catch (err) {
      if (epoch === this.epoch) this.reportError(errText(err));
      return null;
    }
    if (epoch !== this.epoch) return null; // blob dropped before a URL existed — no leak
    return URL.createObjectURL(blob);
  }

  private prefetchChunk(unit: Unit, index: number, epoch: number): void {
    if (index >= unit.length) return;
    if (this.prefetch) return; // one slot deep — laziness stops at N+1
    if (this.current !== unit) return;
    const promise = synthesizeWav(this.opts.url, unit[index]).then(
      (blob) => {
        // Stale (halted/replayed meanwhile): drop the blob without a URL.
        if (epoch !== this.epoch) return null;
        return URL.createObjectURL(blob);
      },
      (err: unknown) => {
        if (epoch === this.epoch) this.reportError(errText(err));
        return null;
      },
    );
    this.prefetch = { index, promise };
  }

  /** Interrupt whatever is playing: bump the epoch, stop audio, revoke every URL we hold. */
  private haltPlayback(): void {
    this.epoch++;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
    }
    if (this.audioUrl !== null) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    if (this.prefetch) {
      const slot = this.prefetch;
      this.prefetch = null;
      // If the URL already resolved it exists but was never consumed — revoke it.
      void slot.promise.then((u) => {
        if (u !== null) URL.revokeObjectURL(u);
      });
    }
    this.current = null;
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
    }
    return this.audio;
  }

  /** Release a chunk's object URL once it finished (or failed) — no leaks either way. */
  private releaseUrl(url: string): void {
    if (this.audioUrl === url) this.audioUrl = null;
    URL.revokeObjectURL(url);
  }

  private setState(state: TtsState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private reportError(message: string): void {
    this.opts.onError?.(message);
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
async function synthesizeWav(endpoint: string, text: string): Promise<Blob> {
  const res = await request(
    endpoint,
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
