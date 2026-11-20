/**
 * Voice-mode controller (PHASE-14) — the glue between the pure gesture reducer,
 * the banner session, the audio pipelines, and the store. Owns all mutable voice
 * state; the overlay is a dumb view fed by `onUi`.
 *
 * Send semantics (PHASE-18): auto-send is gone — the ONLY send path is the
 * double-tap. Recording starts from full idle only (no follow-up recordings,
 * PHASE-17 Gap D), so a voice transcript always goes out through the normal
 * prompt path. The STOP button and the long-press both abort through the
 * same `store.abort()`.
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
import type { SpeakListener } from "../speak-context";
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
  /** Overlay repaint hook: glow phase + activity/hint text (null = hidden). */
  onUi?: (phase: VoiceGlowPhase, activity: string | null) => void;
  /** Smoothed audio amplitude for the reactive glow (null = not analysing). */
  onAmp?: (amp: number | null) => void;
  onNotice?: (message: string) => void;
  /** Send a prompt through the composer's session path — creates the session
   *  when none exists (the store's sendPrompt silently no-ops on a session-less
   *  tab) and queues while a run is active (typing parity). */
  sendText: (text: string) => Promise<void>;
  /** Abort the running agent (STOP button / long-press). */
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
  /** Read-aloud observers (the message Read button) + its active message id. */
  private speakListeners = new Set<SpeakListener>();
  private speakId: string | null = null;
  private mode: "voice" | "normal" = "normal";
  /** Entry ids already spoken-or-skipped: no history replay on toggle-on. */
  private seenIds = new Set<string>();
  private lastSessionId: string | null = null;
  private lastRunning = false;
  private unsub: (() => void) | null = null;

  constructor(private readonly opts: VoiceControllerOptions) {
    this.session = new VoiceSession(opts.prompts);
    this.tts = new TtsPlayer({
      url: opts.ttsUrl,
      onError: (m) => {
        this.emitSpeakError(m);
        opts.onNotice?.(`Voice TTS — ${m}`);
      },
      onAmp: opts.onAmp,
      onStateChange: (st) => {
        this.ttsGlow = st === "idle" ? "off" : st;
        // Gesture layer: synthesizing counts as "speech pending" — tap holds
        // the queue, double-tap interrupts it to record.
        if (st === "idle") this.ui = { ...this.ui, playback: "off" };
        else if (st === "paused") this.ui = { ...this.ui, playback: "paused" };
        else this.ui = { ...this.ui, playback: "on" };
        this.emitSpeak(st);
        this.paint();
      },
    });
    this.recorder = new VoiceRecorder({
      url: opts.sttUrl,
      onError: (m) => opts.onNotice?.(`Voice STT — ${m}`),
      // Mic amp deliberately NOT wired (user call, PHASE-17 Gap F): the
      // recording glow keeps the CSS breath — the on-device envelope read as
      // static in 0.5.2. The feed path stays dormant in stt.ts for a future
      // retune. Recorder policy (PHASE-18) routes through the reducer so every
      // state change stays testable — timers never auto-send.
      onAudio: () => this.dispatch("audio_registered"),
      onSilencePause: () => this.dispatch("silence_pause"),
      onSilenceDiscard: () => this.dispatch("silence_discard"),
      onCapWarning: () => this.dispatch("cap_warning"),
      onCapReached: () => this.dispatch("cap_reached"),
    });
    this.unsub = opts.store.subscribe(() => this.feed());
    this.feed();
    this.lastRunning = opts.store.state.agentRunning;
  }

  /** First pointer gesture on the overlay — unlock iOS autoplay. */
  unlock(): void {
    this.tts.unlock();
  }

  /**
   * Read-aloud (0.5.6): the message Read button shares this pipeline — same
   * chunking and endpoint as voice mode. An explicit press interrupts
   * whatever is speaking (voice speech included): user action wins.
   */
  speakMessage(id: string, text: string): void {
    this.tts.unlock(); // runs inside the click — the iOS gesture
    this.tts.stopAndFlush();
    this.speakId = id;
    this.tts.beginUtterance();
    this.tts.noteText(text);
    this.tts.endUtterance();
  }

  /** Stop the current read-aloud (the button pressed while playing). */
  stopSpeaking(): void {
    this.speakId = null;
    this.tts.stopAndFlush();
  }

  subscribeSpeak(fn: SpeakListener): () => void {
    this.speakListeners.add(fn);
    return () => this.speakListeners.delete(fn);
  }

  private emitSpeak(st: "idle" | "synthesizing" | "playing" | "paused"): void {
    const phase = st === "synthesizing" ? "loading" : st === "idle" ? "idle" : "playing";
    const id = this.speakId;
    if (st === "idle") this.speakId = null;
    for (const fn of this.speakListeners) fn(id, phase);
  }

  private emitSpeakError(message: string): void {
    const id = this.speakId;
    this.speakId = null;
    for (const fn of this.speakListeners) fn(id, "idle", message);
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

  /** Slide-off during a hold — cancels the pending destructive action. */
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
      case "skip_playback":
        // PHASE-17: the utterance finishes synthesizing into the replay cache
        // but never plays; the next queued message starts.
        this.tts.skipCurrent();
        break;
      case "stop_run":
        this.stopRun();
        break;
      default:
        break;
    }
  }

  /** Record → STT → prompt. The ONLY send path (PHASE-18: auto-send retired). */
  private async sendRecording(): Promise<void> {
    // ui.sttWait (red chaser) is already set by the stop_send transition; it
    // clears when the transcript is back and the prompt goes out.
    let text = "";
    try {
      text = (await this.recorder.stopAndSend()).trim();
    } catch {
      this.dispatch("stt_ended"); // glow back from the red chaser
      return; // recorder already reported via onError
    }
    this.dispatch("stt_ended");
    if (!text) return;
    this.connecting = true; // white chase: sent → run start
    this.paint();
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

  private paint(): void {
    // Activity readout: only while a run is doing something SPECIFIC; the
    // in-between run state shows nothing (the glow already carries it). The
    // cap hint owns the center while it is up (PHASE-18 — persists until the
    // capped recording is sent or discarded).
    const hint =
      this.ui.capReached && this.ui.recording === "paused"
        ? "message cap reached, double tap to send"
        : null;
    const activity =
      hint ??
      (this.opts.store.state.agentRunning
        ? currentActivity(this.opts.store.state.messages)
        : null);
    this.opts.onUi?.(voicePhase(this.ui, this.ttsGlow, this.connecting), activity);
  }
}
