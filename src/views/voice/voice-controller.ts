/**
 * Voice-mode controller (PHASE-14) — the glue between the pure gesture reducer,
 * the banner session, the audio pipelines, and the store. Owns all mutable voice
 * state; the overlay is a dumb view fed by `onUi`.
 *
 * Send semantics (typing parity, plan §1.2): a voice transcript goes out through the
 * normal prompt path when idle and through `queuePrompt(…, "followUp")` when a run is
 * active (queued to the next turn, exactly like typing a follow-up). The stop-run
 * countdown aborts through the same `store.abort()` as the Stop button.
 */
import type { AgentMessage } from "../../api/types";
import type { AgentStore } from "../../state/agent-store";
import {
  initialVoiceUi,
  reduceVoiceUi,
  voicePhase,
  type VoiceAction,
  type VoiceEvent,
  type VoiceGlowPhase,
  type VoiceUi,
  type TtsGlow,
} from "./gesture-state";
import type { VoicePrompts } from "./prompts";
import { currentActivity } from "./activity";
import { VoiceSession } from "./voice-session";
import { TtsPlayer } from "./tts";
import { VoiceRecorder } from "./stt";

export interface VoiceControllerOptions {
  store: AgentStore;
  prompts: VoicePrompts;
  /** OpenAI-compatible TTS base (default https://piper.halfab.net). */
  ttsUrl: string;
  /** OpenAI-compatible STT base (default https://stt.halfab.net). */
  sttUrl: string;
  /** Overlay repaint hook: glow phase + countdown seconds (null = hidden) +
   *  activity text (null = nothing specific — the glow carries the rest). */
  onUi?: (phase: VoiceGlowPhase, countdown: number | null, activity: string | null) => void;
  /** Smoothed audio amplitude for the reactive glow (null = not analysing). */
  onAmp?: (amp: number | null) => void;
  onNotice?: (message: string) => void;
  /** Send a prompt through the composer's session path — creates the session
   *  when none exists (the store's sendPrompt silently no-ops on a session-less
   *  tab) and queues while a run is active (typing parity). */
  sendText: (text: string) => Promise<void>;
  /** Abort the running agent (STOP button / countdown). */
  abortRun: () => Promise<void>;
}

/** Plain text of a message: string content or concatenated text blocks. */
export function messageText(msg: AgentMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

export class VoiceController {
  /** Per-send banner machinery (mode/announced/bannerVerified). */
  readonly session: VoiceSession;

  private readonly tts: TtsPlayer;
  private readonly recorder: VoiceRecorder;
  private ui: VoiceUi = initialVoiceUi;
  /** connecting = transcribe+send until the run starts (white chase). */
  private connecting = false;
  /** TTS pipeline state for the glow (green breath > green chase > white). */
  private ttsGlow: TtsGlow = "off";
  /** The utterance being streamed to TTS (its assistant message index). */
  private utter: { idx: number } | null = null;
  /** Utterance whose speech was stopped — never restart it. */
  private suppressIdx = -1;
  private mode: "voice" | "normal" = "normal";
  private countdownTimer: number | null = null;
  private countdownLeft = 0;
  /** Entry ids already spoken-or-skipped: no history replay on toggle-on. */
  private seenIds = new Set<string>();
  private lastSessionId: string | null = null;
  private lastRunning = false;
  private unsub: (() => void) | null = null;

  constructor(private readonly opts: VoiceControllerOptions) {
    this.session = new VoiceSession(opts.prompts);
    this.tts = new TtsPlayer({
      url: opts.ttsUrl,
      onError: (m) => opts.onNotice?.(`Voice TTS — ${m}`),
      onAmp: opts.onAmp,
      onStateChange: (st) => {
        this.ttsGlow = st === "idle" ? "off" : st;
        // Gesture layer: synthesizing counts as "speech pending" — tap holds
        // the queue, double-tap interrupts it to record.
        if (st === "idle") this.ui = { ...this.ui, playback: "off" };
        else if (st === "paused") this.ui = { ...this.ui, playback: "paused" };
        else this.ui = { ...this.ui, playback: "on" };
        this.paint();
      },
    });
    this.recorder = new VoiceRecorder({
      url: opts.sttUrl,
      onError: (m) => opts.onNotice?.(`Voice STT — ${m}`),
      // Mic amp deliberately NOT wired (user call): the recording glow keeps
      // the CSS breath — the on-device envelope read as static. The feed path
      // stays dormant in stt.ts for a future retune (200 ms feed cadence and
      // mic level vs. gain are the first suspects).
      // 60 s silence / 5 min cap auto-send (pi-voice-chat parity).
      onAutoStop: () => void this.sendRecording(),
    });
    this.unsub = opts.store.subscribe(() => this.feed());
    this.feed();
    this.lastRunning = opts.store.state.agentRunning;
  }

  /** First pointer gesture on the overlay — unlock iOS autoplay. */
  unlock(): void {
    this.tts.unlock();
  }

  get voiceMode(): boolean {
    return this.mode === "voice";
  }

  /** Toggle voice mode for this tab. Off: stop audio, drop any recording. */
  setVoiceMode(on: boolean): void {
    this.mode = on ? "voice" : "normal";
    if (on) {
      // History is never spoken: everything already in the store at activation
      // is history and gets marked seen right here (0.5.1 — closes the entry-id
      // timing race that could replay an old reply at toggle-on). Exception: a
      // run in flight gets its reply spoken.
      const s = this.opts.store.state;
      for (let i = 0; i < s.entryIds.length; i++) {
        if (s.agentRunning && i === s.entryIds.length - 1) continue;
        this.seenIds.add(s.entryIds[i]);
      }
      this.paint();
      // Absorb WebKit's first-recording-is-empty quirk with a throwaway clip —
      // the panel tap is a user gesture, so getUserMedia is legal right here.
      void this.recorder.prime();
    } else {
      this.connecting = false;
      if (this.utter) {
        this.suppressIdx = this.utter.idx;
        this.utter = null;
      }
      this.tts.stopAndFlush();
      this.recorder.discard();
      this.clearCountdown();
      this.ui = { ...initialVoiceUi, runActive: this.ui.runActive };
      this.paint();
    }
  }

  /** Composer sends pass through here: typed = normal mode banner state. */
  wrapTyped(text: string): string {
    this.session.mode = "normal";
    return this.session.wrapOutgoing(text);
  }

  // ------------------------------------------------------------- gestures (overlay)

  tap(): void {
    this.dispatch("tap");
  }

  doubleTap(): void {
    this.dispatch("double_tap");
  }

  longPress(): void {
    this.dispatch("long_press");
  }

  longRelease(): void {
    this.dispatch("long_release");
  }

  /** Slide-off during a hold — discard the recording. */
  holdCancel(): void {
    this.dispatch("hold_cancel");
  }

  /** Visible STOP button (beta3): abort the run — the hold gesture now records. */
  stopRun(): void {
    // "stopped means stopped": drop pending speech and never restart the
    // cancelled utterance — the aborted tail must not be spoken.
    if (this.utter) {
      this.suppressIdx = this.utter.idx;
      this.utter = null;
    }
    this.tts.stopAndFlush();
    void this.opts.abortRun();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.clearCountdown();
    this.tts.stopAndFlush();
    this.recorder.discard();
  }

  // ---------------------------------------------------------------- internals

  private dispatch(ev: VoiceEvent): void {
    const { ui, action } = reduceVoiceUi(this.ui, ev);
    this.ui = ui;
    this.execute(action);
    this.paint();
  }

  private execute(action: VoiceAction): void {
    switch (action) {
      case "start_recording":
        void this.recorder.start();
        break;
      case "stop_send":
        void this.sendRecording();
        break;
      case "pause_recording":
        this.recorder.pause();
        break;
      case "resume_recording":
        this.recorder.resume();
        break;
      case "discard_recording":
        this.recorder.discard();
        break;
      case "pause_playback":
        this.tts.togglePause();
        break;
      case "resume_playback":
        this.tts.togglePause();
        break;
      case "replay":
        this.tts.replayCurrent();
        break;
      case "stop_playback_start_recording":
        this.tts.stopAndFlush();
        void this.recorder.start();
        break;
      case "show_stop_countdown":
        this.startCountdown();
        break;
      case "cancel_stop_countdown":
        this.clearCountdown();
        break;
      case "stop_run":
        this.stopRun();
        break;
      default:
        break;
    }
  }

  /** Record → STT → prompt (or queue when a run is active). */
  private async sendRecording(): Promise<void> {
    this.ui = { ...this.ui, recording: "off" };
    this.connecting = true; // glow: arc until the run starts (transcribe + send)
    this.paint();
    let text = "";
    try {
      text = (await this.recorder.stopAndSend()).trim();
    } catch {
      return; // recorder already reported via onError
    }
    if (!text) return;
    this.session.mode = "voice";
    const wrapped = this.session.wrapOutgoing(text);
    await this.opts.sendText(wrapped);
  }

  /**
   * Store feed: banner context tracking, run transitions for the reducer, and TTS
   * for assistant messages that complete while voice mode is on. History is never
   * spoken — the seen-set is primed per session.
   */
  private feed(): void {
    const s = this.opts.store.state;

    if (s.sessionId !== this.lastSessionId) {
      this.lastSessionId = s.sessionId;
      this.session.bind(s.messages.map(messageText));
      this.seenIds = new Set(s.entryIds);
    }
    this.session.noteContextTokens(s.contextUsage?.tokens ?? null);

    if (s.agentRunning !== this.lastRunning) {
      this.lastRunning = s.agentRunning;
      if (s.agentRunning) this.connecting = false;
      this.ui = reduceVoiceUi(this.ui, s.agentRunning ? "run_started" : "run_ended").ui;
    }

    if (this.mode === "voice") {
      // ---- streaming TTS (0.5.2): one utterance per assistant message, fed
      // incrementally so mid-run text speaks mid-run and the final response
      // starts at its first break instead of after the whole message.
      // Complete = a later entry exists (toolResult included) or the run
      // ended — that flushes the tail.
      if (this.utter) {
        const complete =
          s.messages.length - 1 > this.utter.idx || !s.agentRunning;
        if (complete) {
          const done = s.messages[this.utter.idx];
          if (done && done.role === "assistant") this.tts.noteText(messageText(done));
          const id = s.entryIds[this.utter.idx];
          if (id) this.seenIds.add(id);
          this.suppressIdx = this.utter.idx; // never re-begin a flushed message
          this.utter = null;
          this.tts.endUtterance();
        }
      }

      // Live turn = the last assistant message, never crossing a user message.
      let liveIdx = -1;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (m.role === "assistant") {
          liveIdx = i;
          break;
        }
        if (m.role === "user") break;
      }
      if (liveIdx >= 0 && liveIdx !== this.suppressIdx) {
        if (!this.utter) {
          const id = s.entryIds[liveIdx];
          if (!id || !this.seenIds.has(id)) {
            this.utter = { idx: liveIdx };
            this.tts.beginUtterance();
          }
        }
        if (this.utter && this.utter.idx === liveIdx) {
          this.tts.noteText(messageText(s.messages[liveIdx]));
        }
      }
    } else {
      for (const id of s.entryIds) this.seenIds.add(id);
    }

    this.paint();
  }

  private startCountdown(): void {
    this.clearCountdown();
    this.countdownLeft = 3;
    this.paint();
    this.countdownTimer = window.setInterval(() => {
      this.countdownLeft -= 1;
      if (this.countdownLeft <= 0) {
        this.clearCountdown();
        this.dispatch("countdown_done");
      } else {
        this.paint();
      }
    }, 1000);
  }

  private clearCountdown(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private paint(): void {
    // Activity readout: only while a run is doing something SPECIFIC; the
    // in-between run state shows nothing (the glow already carries it). The
    // stop countdown owns the center while it runs.
    const countdown = this.countdownTimer !== null ? this.countdownLeft : null;
    const activity =
      countdown === null && this.opts.store.state.agentRunning
        ? currentActivity(this.opts.store.state.messages)
        : null;
    this.opts.onUi?.(
      voicePhase(this.ui, this.ttsGlow, this.connecting),
      countdown,
      activity,
    );
  }
}
