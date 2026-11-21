/**
 * Audio-reactive glow amplitude (0.5.2) — the audio-reactive visualization
 * behind `--breath`: a smoothed RMS envelope (fast attack / slow release so it
 * breathes WITH the words instead of twitching like a VU meter), fed from
 * either an AnalyserNode tap on TTS playback or the recorder's mic samples.
 * The overlay pins `--breath` to the envelope while it flows and falls back to
 * the CSS breath when it stops (onAmp(null)).
 *
 * Browser APIs only. Optional by design: any failure just leaves the CSS
 * breath in charge.
 */

export interface AudioAmpOptions {
  /** Smoothed amplitude 0..1, or null when analysis stops. */
  onAmp: (amp: number | null) => void;
  /** RMS → 0..1 scaling (speech peaks should land near 1). */
  gain?: number;
  /** Envelope time constants (ms): attack when rising, release when falling. */
  attackMs?: number;
  releaseMs?: number;
}

function rmsOf(samples: Float32Array | Uint8Array): number {
  let sum = 0;
  if (samples instanceof Float32Array) {
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  } else {
    for (let i = 0; i < samples.length; i++) {
      const v = (samples[i] - 128) / 128;
      sum += v * v;
    }
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export class AudioAmp {
  private env = 0;
  private lastT = 0;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private buf: Uint8Array | null = null;
  private el: HTMLAudioElement | null = null;
  /** True while the tap is actually emitting values (playback live). */
  private emitting = false;
  /** rAF loop body (tapElement) — parked when no audio flows (PHASE-20). */
  private tickLoop: (() => void) | null = null;

  constructor(private readonly opts: AudioAmpOptions) {}

  /** Mic path: time-domain samples straight from the recorder's analyser. */
  feedSamples(samples: Float32Array | Uint8Array): void {
    this.push(rmsOf(samples));
  }

  /**
   * TTS path: tap an audio element's output (source → analyser → destination).
   * MUST run from a user gesture (iOS): once createMediaElementSource takes an
   * element its audio flows through the context, so the context is only built
   * after unlock() and re-resumed if the platform suspends it. Failures leave
   * the element untouched and the CSS breath in charge.
   */
  tapElement(el: HTMLAudioElement): void {
    if (this.analyser) return;
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const src = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.el = el;
      this.buf = new Uint8Array(analyser.fftSize);
      void ctx.resume();
      // PHASE-20 (heat): the measurement loop SUSPENDS whenever no audio is
      // flowing — the old free-running rAF tick woke the CPU ~60/s forever
      // after the tap (the tap itself stays permanent; only the loop parks).
      // "playing" restarts it (also on unpause) and carries the backgrounding
      // keep-alive that the loop used to do.
      this.tickLoop = null;
      const tick = (): void => {
        if (!this.analyser || !this.buf || !this.el) return;
        // Backgrounding can suspend the context — and with it the element's
        // audio (it routes through the graph now). Keep it alive.
        if (this.ctx && this.ctx.state !== "running") void this.ctx.resume();
        // Measure ONLY while audio actually flows. An idle element's silence
        // feeds zeros forever and pins the glow at --breath 0 with the CSS
        // animation frozen — it clobbered the mic envelope and the recording
        // breath in 0.5.2/0.5.3 (the tap outlives the playback on purpose).
        const live = !this.el.paused && !this.el.ended;
        if (!live) {
          if (this.emitting) {
            this.emitting = false;
            this.env = 0;
            this.lastT = 0;
            this.opts.onAmp(null);
          }
          this.suspendLoop();
          return;
        }
        this.emitting = true;
        this.analyser.getByteTimeDomainData(this.buf as Uint8Array<ArrayBuffer>);
        this.push(rmsOf(this.buf));
        this.raf = requestAnimationFrame(tick);
      };
      this.tickLoop = tick;
      const resume = () => {
        if (this.ctx && this.ctx.state !== "running") void this.ctx.resume();
        if (!this.raf && this.tickLoop) this.raf = requestAnimationFrame(this.tickLoop);
      };
      el.addEventListener("playing", resume);
      const loop = this.tickLoop;
      if (loop) this.raf = requestAnimationFrame(loop);
    } catch {
      /* analysis is optional — the CSS breath is the fallback */
    }
  }

  private push(rms: number): void {
    const gain = this.opts.gain ?? 4;
    const target = Math.min(1, rms * gain);
    const now = performance.now();
    const dt = this.lastT ? Math.min(200, now - this.lastT) : 16;
    this.lastT = now;
    const tau =
      target > this.env
        ? (this.opts.attackMs ?? 60)
        : (this.opts.releaseMs ?? 280);
    this.env += (target - this.env) * (1 - Math.exp(-dt / tau));
    this.opts.onAmp(this.env);
  }

  /** Park the measurement loop (the tap itself is permanent). */
  private suspendLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Stop feeding (the tap itself is permanent once created — cheap idle). */
  stop(): void {
    this.suspendLoop();
    this.emitting = false;
    this.env = 0;
    this.lastT = 0;
    this.opts.onAmp(null);
  }
}
