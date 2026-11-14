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
} from "./gesture-state";
import type { VoicePrompts } from "./prompts";
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
  /** Overlay repaint hook: glow phase + countdown seconds (null = hidden). */
  onUi?: (phase: VoiceGlowPhase, countdown: number | null) => void;
  onNotice?: (message: string) => void;
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
      onStateChange: (st) => {
        if (st === "idle") this.ui = { ...this.ui, playback: "off" };
        else if (st === "paused") this.ui = { ...this.ui, playback: "paused" };
        else if (st === "playing") this.ui = { ...this.ui, playback: "on" };
        this.paint();
      },
    });
    this.recorder = new VoiceRecorder({
      url: opts.sttUrl,
      onError: (m) => opts.onNotice?.(`Voice STT — ${m}`),
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
    if (!on) {
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
        void this.opts.store.abort();
        break;
      default:
        break;
    }
  }

  /** Record → STT → prompt (or queue when a run is active). */
  private async sendRecording(): Promise<void> {
    this.ui = { ...this.ui, recording: "off" };
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
    const store = this.opts.store;
    if (store.state.agentRunning) await store.queuePrompt(wrapped, "followUp");
    else await store.sendPrompt(wrapped);
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
      this.ui = reduceVoiceUi(this.ui, s.agentRunning ? "run_started" : "run_ended").ui;
    }

    if (this.mode === "voice") {
      s.messages.forEach((m, i) => {
        const id = s.entryIds[i];
        if (!id || this.seenIds.has(id)) return;
        this.seenIds.add(id);
        if (m.role === "assistant") {
          const text = messageText(m).trim();
          if (text) this.tts.enqueue(text);
        }
      });
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
    this.opts.onUi?.(voicePhase(this.ui), this.countdownTimer !== null ? this.countdownLeft : null);
  }
}
