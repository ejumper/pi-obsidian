/**
 * Voice-mode dictation recorder (PHASE-18) — getUserMedia + Web Audio PCM
 * capture with the chunk-on-silence transcription pipeline (§B) and the
 * PHASE-18 recording policy.
 *
 * Capture is raw PCM through a ScriptProcessor tap (not MediaRecorder): the
 * chunker needs sample-exact cuts — it cuts AT a silence onset, retroactively,
 * so no speech is ever lost at a boundary — and each chunk is uploaded as a
 * self-contained WAV (no container quirks: the iOS first-recording-empty
 * MediaRecorder bug class is gone with it).
 *
 * Pipeline: blocks accumulate into the current chunk; the policy tick cuts
 * chunks per `chunkCutAction` (silence ≥ 2.5 s after ≥ 20 s of audio, or the
 * 60 s hard ceiling); each cut chunk transcribes SEQUENTIALLY while recording
 * continues (bounded memory: audio is dropped once its text is confirmed).
 * `stopAndSend` flushes the final chunk, waits for the queue, retries failures
 * once more, and concatenates the partials — the model starts in seconds, not
 * minutes. Chunks with no speech are never transcribed; a chunk that keeps
 * failing LOUDLY fails the send (text is never silently lost).
 *
 * Policy timers NEVER auto-send (auto-send was retired): 30 s of silence
 * pauses (or discards an accidental start), the 15-min cap pauses absolutely.
 *
 * Browser APIs only (getUserMedia, Web Audio, fetch) — no Obsidian imports,
 * no npm deps. The fetch error style mirrors tts.ts; each file stays
 * self-contained.
 */
import { AudioAmp } from "./audio-amp";

const SILENCE_RMS = 0.02;
const SILENCE_WINDOW_MS = 30_000;
const MAX_RECORDING_MS = 15 * 60_000;
const CAP_WARNING_BEFORE_MS = 30_000;
const WATCH_TICK_MS = 200;
/** Chunk-on-silence tuning (PHASE-18B — generous, not pseudo-streaming). */
const CUT_SILENCE_MS = 2_500;
const MIN_CHUNK_MS = 20_000;
const MAX_CHUNK_MS = 60_000;
const CHUNK_ATTEMPTS = 2;
const STT_PATH = "/v1/audio/transcriptions";
const STT_MODEL = "small.en";

/**
 * Chunk-cut policy (pure, tested): what to do with the current chunk.
 * `gapMs` = length of the ONGOING silence run (0 while speech is flowing).
 * "cut_silence" cuts AT the silence onset (retroactive — the silence carries
 * over as the next chunk's lead-in); "cut_now" cuts at the live edge (only the
 * 60 s ceiling mid-speech — lossless for PCM, a seam word may mangle).
 */
export function chunkCutAction(
  curMs: number,
  gapMs: number,
  hasSpeech: boolean,
): "none" | "cut_silence" | "cut_now" {
  if (curMs >= MAX_CHUNK_MS) return gapMs > 0 ? "cut_silence" : "cut_now";
  if (hasSpeech && gapMs >= CUT_SILENCE_MS && curMs >= MIN_CHUNK_MS) return "cut_silence";
  return "none";
}

/** One cut chunk awaiting/holding its transcript. */
interface PendingChunk {
  samples: Float32Array;
  text: string | null;
  error: string | null;
}

export interface VoiceRecorderOptions {
  /** Base STT URL, e.g. https://stt.halfab.net (path appended if missing). */
  url: string;
  /** 30 s of silence AFTER speech was registered — pause (audio preserved). */
  onSilencePause?: () => void;
  /** 30 s of silence with nothing ever spoken — accidental start, discard. */
  onSilenceDiscard?: () => void;
  /** First speech registered in the current recording (send guard). */
  onAudio?: () => void;
  /** 30 s of recording time left — the red 1s/1s blink warning. */
  onCapWarning?: () => void;
  /** 15-min hard cap reached — auto-pause (absolute; only send/discard proceed). */
  onCapReached?: () => void;
  onError?: (message: string) => void;
  /** Smoothed mic amplitude for the reactive glow (null = not recording). */
  onAmp?: (amp: number | null) => void;
}

export class VoiceRecorder {
  // ── mic graph ───────────────────────────────────────────────────────────
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private muteGain: GainNode | null = null;

  /** off | on | paused — pause drops incoming blocks (audio preserved below). */
  private recording: "off" | "on" | "paused" = "off";
  private sampleRate = 48_000;

  /** Mic amplitude envelope for the reactive glow (fed from the PCM tap). */
  private amp: AudioAmp | null;

  // ── current chunk accumulation ──────────────────────────────────────────
  private parts: Float32Array[] = [];
  private curSamples = 0;
  private curHasSpeech = false;
  /** Sample offset (within the current chunk) where the ongoing silence run
   *  began — the retroactive cut point; null while speech flows. */
  private curSilenceAt: number | null = null;
  private speechRegistered = false;
  private silenceStart: number | null = null;
  private silenceFired = false;

  // ── transcription queue ─────────────────────────────────────────────────
  private chunks: PendingChunk[] = [];
  private pumpPromise: Promise<void> | null = null;

  // ── recording-time budget (15-min accumulated cap) ──────────────────────
  private capTimer: number | null = null;
  private capWarnTimer: number | null = null;
  private capLeft = MAX_RECORDING_MS;
  private capArmedAt = 0;
  private watchTimer: number | null = null;

  constructor(private readonly opts: VoiceRecorderOptions) {
    this.amp = opts.onAmp ? new AudioAmp({ onAmp: opts.onAmp, gain: 5 }) : null;
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /**
   * Open the mic and start recording. MUST run inside a user gesture: iOS
   * WKWebView ties getUserMedia permission to the requesting gesture.
   */
  async start(): Promise<void> {
    if (this.recording !== "off") {
      this.discard(); // defensive: leftovers — drop them, start over
    }
    if (
      typeof AudioContext === "undefined" ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.error("Microphone recording is not available in this context");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.error(`Microphone unavailable: ${errText(err)}`);
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
      this.sampleRate = ctx.sampleRate;
      const source = ctx.createMediaStreamSource(stream);
      // 2048-sample mono tap. A ScriptProcessor must feed the destination to
      // fire reliably (through a zero gain — nothing is monitored or echoed).
      const processor = ctx.createScriptProcessor(2048, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);
      processor.onaudioprocess = (e) => this.onAudio(e);
      if (ctx.state === "suspended") await ctx.resume().catch(() => undefined);
      this.stream = stream;
      this.audioCtx = ctx;
      this.source = source;
      this.processor = processor;
      this.muteGain = mute;
    } catch (err) {
      stopTracks(stream);
      this.error(`Recorder unavailable: ${errText(err)}`);
      return;
    }
    // Fresh chunk + policy state for this recording.
    this.parts = [];
    this.curSamples = 0;
    this.curHasSpeech = false;
    this.curSilenceAt = null;
    this.speechRegistered = false;
    this.silenceFired = false;
    this.silenceStart = null;
    this.capLeft = MAX_RECORDING_MS;
    this.recording = "on";
    this.armCap();
    this.watchTimer = setInterval(() => this.policyTick(), WATCH_TICK_MS);
  }

  /** Pause: audio preserved, policy/cap timers bank (tap resumes). */
  pause(): void {
    if (this.recording !== "on") return;
    this.recording = "paused";
    this.silenceStart = null;
    this.bankCap();
    // Recording held → freeze the amp (the glow falls back to the CSS steady).
    this.amp?.stop();
  }

  resume(): void {
    if (this.recording !== "paused") return;
    this.recording = "on";
    // Fresh silence window per resume — 30 s of quiet pauses again.
    this.silenceFired = false;
    this.silenceStart = null;
    this.armCap();
  }

  /** Stop and drop everything (partial chunks included); reusable after. */
  discard(): void {
    this.stopCapture();
    this.parts = [];
    this.curSamples = 0;
    this.curHasSpeech = false;
    this.curSilenceAt = null;
    this.chunks = [];
  }

  /**
   * Stop the recorder, flush the final chunk, drain the transcription queue
   * (one more retry pass for stragglers), and return the full transcript.
   * The ONLY send path (PHASE-18: auto-send retired).
   */
  async stopAndSend(): Promise<string> {
    this.stopCapture();
    if (this.curHasSpeech && this.curSamples > 0) {
      this.chunks.push({ samples: this.concatParts(), text: null, error: null });
      this.parts = [];
      this.curSamples = 0;
      this.curHasSpeech = false;
      this.curSilenceAt = null;
    }
    if (this.chunks.length === 0) {
      const msg = "Nothing was recorded";
      this.error(msg);
      throw new Error(msg);
    }
    // Drain: whatever is in flight finishes, then one retry pass for failures.
    if (this.pumpPromise) await this.pumpPromise;
    await this.transcribeLoop();
    const failed = this.chunks.find((c) => c.text === null);
    if (failed) {
      const msg = `Transcription failed (${failed.error ?? "unknown error"}) — the recording was not sent`;
      this.error(msg);
      throw new Error(msg);
    }
    return this.chunks
      .map((c) => c.text ?? "")
      .filter((t) => t.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ── PCM capture ─────────────────────────────────────────────────────────

  private onAudio(e: AudioProcessingEvent): void {
    if (this.recording !== "on") return; // paused/stopped: drop the block
    if (e.inputBuffer.numberOfChannels < 1) return;
    const input = e.inputBuffer.getChannelData(0);
    const block = new Float32Array(input); // input buffers are reused — copy
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    this.amp?.feedSamples(block);
    if (rms >= SILENCE_RMS) {
      if (!this.speechRegistered) {
        this.speechRegistered = true;
        this.opts.onAudio?.();
      }
      this.curHasSpeech = true;
      this.curSilenceAt = null;
      this.silenceStart = null;
    } else {
      if (this.curSilenceAt === null) this.curSilenceAt = this.curSamples;
      if (this.silenceStart === null) this.silenceStart = Date.now();
    }
    this.parts.push(block);
    this.curSamples += block.length;
  }

  // ── policy tick (silence policy + chunk cuts) ───────────────────────────

  private policyTick(): void {
    if (this.recording !== "on") return;
    // PHASE-18 policy: 30 s of silence pauses (speech registered) or discards
    // (accidental start). Never sends.
    if (this.silenceStart !== null && !this.silenceFired) {
      if (Date.now() - this.silenceStart >= SILENCE_WINDOW_MS) {
        this.silenceFired = true;
        if (this.speechRegistered) this.opts.onSilencePause?.();
        else this.opts.onSilenceDiscard?.();
        return;
      }
    }
    const gapMs =
      this.curSilenceAt !== null
        ? ((this.curSamples - this.curSilenceAt) / this.sampleRate) * 1000
        : 0;
    const curMs = (this.curSamples / this.sampleRate) * 1000;
    const action = chunkCutAction(curMs, gapMs, this.curHasSpeech);
    if (action === "cut_silence") this.cutChunk(this.curSilenceAt ?? this.curSamples);
    else if (action === "cut_now") this.cutChunk(this.curSamples);
  }

  /**
   * Cut the current chunk AT a sample offset. The remainder (always the
   * silence run, or empty for a live-edge cut) carries over as the next
   * chunk's lead-in — cuts never lose speech.
   */
  private cutChunk(at: number): void {
    const total = this.curSamples;
    const cut = Math.max(0, Math.min(at, total));
    // takeSamples mutates this.parts in place — it is the remainder afterwards.
    const taken = takeSamples(this.parts, cut);
    if (taken.length > 0) {
      this.chunks.push({ samples: taken, text: null, error: null });
      this.startPump();
    }
    this.curSamples = total - cut;
    this.curHasSpeech = false; // the remainder is the ongoing silence run
    this.curSilenceAt = this.curSamples > 0 ? 0 : null;
  }

  /** Concatenate the pending blocks into one buffer. */
  private concatParts(): Float32Array {
    const out = new Float32Array(this.curSamples);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  // ── transcription queue ─────────────────────────────────────────────────

  private startPump(): void {
    if (this.pumpPromise) return;
    this.pumpPromise = this.transcribeLoop().finally(() => {
      this.pumpPromise = null;
    });
  }

  /** Sequential, order-preserving transcription of un-transcribed chunks. */
  private async transcribeLoop(): Promise<void> {
    for (const chunk of this.chunks) {
      if (chunk.text !== null) continue;
      let lastErr = "unknown error";
      for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
        try {
          chunk.text = await this.upload(chunk.samples);
          chunk.error = null;
          lastErr = "";
          break;
        } catch (err) {
          lastErr = errText(err);
        }
      }
      if (chunk.text === null) chunk.error = lastErr;
    }
  }

  private async upload(samples: Float32Array): Promise<string> {
    const form = new FormData();
    form.append("file", encodeWav(samples, this.sampleRate), "recording.wav");
    form.append("model", STT_MODEL);
    const endpoint = this.opts.url.endsWith(STT_PATH)
      ? this.opts.url
      : `${this.opts.url.replace(/\/+$/, "")}${STT_PATH}`;
    const res = await request(endpoint, { method: "POST", body: form }, "Transcription failed");
    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      throw new Error(`Transcription failed: invalid JSON in response (${errText(err)})`);
    }
    const text = (data as { text?: unknown }).text;
    if (typeof text !== "string") {
      throw new Error("Transcription failed: response had no text field");
    }
    return text;
  }

  // ── cap budget (accumulated recording time) ─────────────────────────────

  private armCap(): void {
    const warnIn = this.capLeft - CAP_WARNING_BEFORE_MS;
    if (warnIn > 0) {
      this.capWarnTimer = setTimeout(() => {
        this.capWarnTimer = null;
        this.opts.onCapWarning?.();
      }, warnIn);
    }
    this.capArmedAt = Date.now();
    this.capTimer = setTimeout(() => {
      this.capTimer = null;
      if (this.capWarnTimer !== null) {
        clearTimeout(this.capWarnTimer);
        this.capWarnTimer = null;
      }
      this.opts.onCapReached?.();
    }, this.capLeft);
  }

  private bankCap(): void {
    if (this.capTimer !== null) {
      this.capLeft = Math.max(1, this.capLeft - (Date.now() - this.capArmedAt));
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
    if (this.capWarnTimer !== null) {
      clearTimeout(this.capWarnTimer);
      this.capWarnTimer = null;
    }
  }

  // ── teardown ────────────────────────────────────────────────────────────

  private stopCapture(): void {
    this.recording = "off";
    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    this.bankCap();
    this.amp?.stop();
    if (this.processor) {
      this.processor.onaudioprocess = null;
      try {
        this.processor.disconnect();
      } catch {
        // already detached
      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // already detached
      }
      this.source = null;
    }
    if (this.muteGain) {
      try {
        this.muteGain.disconnect();
      } catch {
        // already detached
      }
      this.muteGain = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
    this.silenceStart = null;
  }

  private error(message: string): void {
    this.opts.onError?.(message);
  }
}

// ── helpers (same style as tts.ts; each file self-contained) ──────────────

/** Remove the first `n` samples from `parts` (returned concatenated); the
 *  remainder stays in the array (assigned back by the caller). */
function takeSamples(parts: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n);
  let need = n;
  let off = 0;
  while (need > 0 && parts.length > 0) {
    const head = parts[0];
    if (head.length <= need) {
      out.set(head, off);
      off += head.length;
      need -= head.length;
      parts.shift();
    } else {
      out.set(head.subarray(0, need), off);
      parts[0] = head.subarray(need);
      need = 0;
    }
  }
  return out;
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

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

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
