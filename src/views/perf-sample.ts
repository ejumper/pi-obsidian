/**
 * PHASE-20 measurement: a tiny fps + long-task sampler. Runs ONLY while voice
 * mode is up (the heat report was a voice-use phenomenon); `stop()` returns
 * the window summary, which ChatView logs for the device runs (Logstravaganza
 * ships phone console output back to the vault).
 *
 * Frame counting rides rAF — it measures the frames the compositor actually
 * delivered while the screen was active, which is exactly what the heat work
 * is trying to give back. Long tasks come from PerformanceObserver("longtask")
 * where available (absent on some WebKit builds — the summary then reports 0).
 */

export interface PerfSummary {
  seconds: number;
  fps: number;
  longTasks: number;
  longTaskMs: number;
}

export class PerfSampler {
  private raf = 0;
  private frames = 0;
  private startedAt = 0;
  private longTasks = 0;
  private longTaskMs = 0;
  private observer: PerformanceObserver | null = null;

  start(): void {
    this.startedAt = performance.now();
    this.frames = 0;
    this.longTasks = 0;
    this.longTaskMs = 0;
    const tick = (): void => {
      this.frames++;
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTasks++;
          this.longTaskMs += entry.duration;
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
      this.observer = obs;
    } catch {
      this.observer = null; // not supported — fps still reports
    }
  }

  stop(): PerfSummary | null {
    if (this.startedAt === 0) return null;
    const seconds = Math.max(0.001, (performance.now() - this.startedAt) / 1000);
    const summary: PerfSummary = {
      seconds: Math.round(seconds * 10) / 10,
      fps: Math.round((this.frames / seconds) * 10) / 10,
      longTasks: this.longTasks,
      longTaskMs: Math.round(this.longTaskMs),
    };
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.observer?.disconnect();
    this.observer = null;
    this.startedAt = 0;
    return summary;
  }
}
