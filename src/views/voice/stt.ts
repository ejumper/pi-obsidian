/**
 * Voice-mode dictation recorder — getUserMedia + MediaRecorder with silence
 * auto-stop and multipart upload to an OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint (verified live: stt.halfab.net returns
 * `{"text": "..."}`).
 *
 * Browser APIs only (getUserMedia, MediaRecorder, Web Audio, fetch) — no
 * Obsidian imports, no npm deps. The fetch error style mirrors tts.ts; each
 * file stays self-contained.
 */

/** Mime negotiation order: first MediaRecorder.isTypeSupported hit wins; default if none. */
const RECORDER_MIMES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
const SILENCE_RMS = 0.02;
const SILENCE_WINDOW_MS = 60_000;
const MAX_RECORDING_MS = 5 * 60_000;
const WATCH_TICK_MS = 200;
const STOP_WATCHDOG_MS = 5_000;
const STT_PATH = "/v1/audio/transcriptions";
const STT_MODEL = "small.en";

export interface VoiceRecorderOptions {
  /** Base STT URL, e.g. https://stt.halfab.net (path appended if missing). */
  url: string;
  /** 60 s of continuous silence or the 5-minute hard cap — caller decides send vs. discard. */
  onAutoStop?: () => void;
  onError?: (message: string) => void;
}

export class VoiceRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private parts: Blob[] = [];
  private mime = "";

  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private watchTimer: number | null = null;
  private capTimer: number | null = null;
  private silenceStart: number | null = null;
  private silenceFired = false;

  private discardOnStop = false;
  private pendingStop: ((blob: Blob | null) => void) | null = null;
  private stopWatchdog: number | null = null;

  constructor(private readonly opts: VoiceRecorderOptions) {}

  /**
   * Open the mic and start recording. MUST be called from within a user
   * gesture: iOS WKWebView ties the getUserMedia permission prompt (and
   * MediaRecorder's right to capture) to the gesture that requested it.
   */
  async start(): Promise<void> {
    if (this.recorder) {
      // Defensive: leftovers from a previous session — drop them, start over.
      this.discardOnStop = true;
      await this.stopAndWait();
    }
    this.cleanup();

    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
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

    let chosen = "";
    let recorder: MediaRecorder | null = null;
    const wanted = pickMime();
    if (wanted) {
      try {
        recorder = new MediaRecorder(stream, { mimeType: wanted });
        chosen = wanted;
      } catch {
        recorder = null; // claimed supported but refused — fall back to default
      }
    }
    if (!recorder) {
      try {
        recorder = new MediaRecorder(stream);
        chosen = "";
      } catch (err) {
        this.error(`Recorder unavailable: ${errText(err)}`);
        stopTracks(stream);
        return;
      }
    }
    const rec: MediaRecorder = recorder;

    this.stream = stream;
    this.recorder = rec;
    this.parts = [];
    this.mime = rec.mimeType || chosen;
    this.discardOnStop = false;
    this.silenceFired = false;
    this.silenceStart = null;

    // Every handler checks identity so a stale recorder's late events can
    // never corrupt (or tear down) a newer session.
    rec.ondataavailable = (ev) => {
      if (this.recorder === rec && ev.data && ev.data.size > 0) this.parts.push(ev.data);
    };
    rec.onstop = () => this.handleStop(rec);
    rec.onerror = (ev) => {
      if (this.recorder === rec) this.error(`Recorder error: ${ev.message || "recording failed"}`);
    };

    try {
      rec.start();
    } catch (err) {
      this.error(`Could not start recording: ${errText(err)}`);
      this.cleanup();
      return;
    }

    this.armWatches(stream);
  }

  /** Pause recording; the silence watch skips (and restarts its window) while paused. */
  pause(): void {
    const rec = this.recorder;
    if (!rec || rec.state !== "recording") return;
    try {
      rec.pause();
    } catch (err) {
      this.error(`Pause failed: ${errText(err)}`);
      return;
    }
    this.silenceStart = null;
  }

  resume(): void {
    const rec = this.recorder;
    if (!rec || rec.state !== "paused") return;
    try {
      rec.resume();
    } catch (err) {
      this.error(`Resume failed: ${errText(err)}`);
    }
  }

  /** Stop and drop the partial recording; the object stays usable for the next start(). */
  discard(): void {
    const rec = this.recorder;
    if (!rec) {
      this.cleanup();
      return;
    }
    this.discardOnStop = true;
    if (rec.state === "inactive") {
      this.handleStop(rec);
      return;
    }
    try {
      rec.stop();
    } catch (err) {
      this.error(`Could not stop the recorder: ${errText(err)}`);
      this.settleStop(null);
    }
  }

  /**
   * Stop the recorder, collect the final blob, and POST it as multipart form
   * data (`file` + `model: "small.en"`) to `<url>/v1/audio/transcriptions`.
   * Returns the transcript text. Fetch/HTTP/JSON failures report via onError
   * AND reject, so the caller can't mistake them for an empty transcript.
   */
  async stopAndSend(): Promise<string> {
    const blob = await this.stopAndWait();
    if (!blob) {
      const msg = "Transcription skipped: no audio captured (already stopped or discarded?)";
      this.error(msg);
      throw new Error(msg);
    }

    const form = new FormData();
    form.append("file", blob, `recording.${fileExt(this.mime)}`);
    form.append("model", STT_MODEL);

    const endpoint = this.opts.url.endsWith(STT_PATH)
      ? this.opts.url
      : `${this.opts.url.replace(/\/+$/, "")}${STT_PATH}`;
    let res: Response;
    try {
      res = await request(endpoint, { method: "POST", body: form }, "Transcription failed");
    } catch (err) {
      this.error(errText(err));
      throw err;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      const msg = `Transcription failed: invalid JSON in response (${errText(err)})`;
      this.error(msg);
      throw new Error(msg);
    }
    const text = (data as { text?: unknown }).text;
    if (typeof text !== "string") {
      const msg = "Transcription failed: response had no text field";
      this.error(msg);
      throw new Error(msg);
    }
    return text;
  }

  // ── recording lifecycle ─────────────────────────────────────────────────

  /** Silence watch (Web Audio RMS) + 5-minute hard cap — both fire onAutoStop. */
  private armWatches(stream: MediaStream): void {
    this.capTimer = setTimeout(() => {
      this.capTimer = null;
      this.clearWatch(); // the cap supersedes silence detection
      this.opts.onAutoStop?.();
    }, MAX_RECORDING_MS);

    // Analysis only — deliberately NOT connected to the destination, so
    // nothing is monitored or fed back into the mic.
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      this.audioCtx = ctx;
      this.analyser = analyser;
      this.source = source;
      const buf = new Float32Array(analyser.fftSize);
      this.watchTimer = setInterval(() => this.watchTick(buf), WATCH_TICK_MS);
    } catch (err) {
      // No silence detection this session — the hard cap still applies.
      if (ctx) void ctx.close().catch(() => undefined);
      this.error(`Silence detection unavailable: ${errText(err)}`);
    }
  }

  private watchTick(buf: Float32Array<ArrayBuffer>): void {
    const rec = this.recorder;
    const analyser = this.analyser;
    if (!rec || !analyser || rec.state !== "recording" || this.audioCtx?.state !== "running") {
      // Paused (or stopped / suspended context, whose zeros would read as
      // false silence): suspend the measurement so the 60 s window restarts
      // from the next live tick.
      this.silenceStart = null;
      return;
    }
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms >= SILENCE_RMS) {
      this.silenceStart = null;
      return;
    }
    const now = Date.now();
    if (this.silenceStart === null) {
      this.silenceStart = now;
      return;
    }
    if (now - this.silenceStart >= SILENCE_WINDOW_MS && !this.silenceFired) {
      this.silenceFired = true;
      this.stopSilenceWatch(); // the 5-minute cap stays armed as a second chance
      this.opts.onAutoStop?.();
    }
  }

  /** Stop the recorder and resolve with the final blob (null when discarded or failed). */
  private stopAndWait(): Promise<Blob | null> {
    const rec = this.recorder;
    if (!rec || rec.state === "inactive" || this.pendingStop !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingStop = resolve;
      // Watchdog: never hang the caller if the engine skips the final "stop" event.
      this.stopWatchdog = setTimeout(() => {
        this.stopWatchdog = null;
        this.error("Recorder did not emit a final chunk; treating the recording as empty");
        this.settleStop(null);
      }, STOP_WATCHDOG_MS);
      try {
        rec.stop();
      } catch (err) {
        this.error(`Could not stop the recorder: ${errText(err)}`);
        this.settleStop(null);
      }
    });
  }

  /** MediaRecorder "stop" handler: build the blob (unless discarding), settle, clean up. */
  private handleStop(rec: MediaRecorder): void {
    if (this.recorder !== rec) return; // stale recorder — a newer session owns the state
    const type = rec.mimeType || this.mime || "application/octet-stream";
    const blob = !this.discardOnStop && this.parts.length > 0 ? new Blob(this.parts, { type }) : null;
    this.settleStop(blob);
  }

  private settleStop(blob: Blob | null): void {
    if (this.stopWatchdog !== null) {
      clearTimeout(this.stopWatchdog);
      this.stopWatchdog = null;
    }
    const resolve = this.pendingStop;
    this.pendingStop = null;
    this.cleanup();
    resolve?.(blob);
  }

  /** Release mic/stream/audio resources; leaves the object ready for start() again. */
  private cleanup(): void {
    this.clearWatch();
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // already detached
      }
      this.source = null;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
    this.analyser = null;
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
    this.recorder = null;
    this.parts = [];
    this.discardOnStop = false;
    this.silenceStart = null;
  }

  private clearWatch(): void {
    this.stopSilenceWatch();
    if (this.capTimer !== null) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
  }

  private stopSilenceWatch(): void {
    if (this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  private error(message: string): void {
    this.opts.onError?.(message);
  }
}

// ── helpers (same style as tts.ts; each file self-contained) ──────────────

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

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const mime of RECORDER_MIMES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // Some engines throw from isTypeSupported — treat as unsupported.
    }
  }
  return "";
}

/** Filename extension for the upload from the recorder mime, e.g. "audio/webm;…" → "webm". */
function fileExt(mime: string): string {
  const basic = mime.split(";")[0].trim();
  const slash = basic.indexOf("/");
  const subtype = slash >= 0 ? basic.slice(slash + 1) : "";
  return subtype && subtype !== "octet-stream" ? subtype : "bin";
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
