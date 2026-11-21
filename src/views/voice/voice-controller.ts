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
import { initialSlotState, reduceSlot, slotView, type SlotState, type SlotView } from "./slot-state";

export interface VoiceControllerOptions {
  store: AgentStore;
  prompts: VoicePrompts;
  /** OpenAI-compatible TTS base (default https://piper.halfab.net). */
  ttsUrl: string;
  /** OpenAI-compatible STT base (default https://stt.halfab.net). */
  sttUrl: string;
  /** Overlay repaint hook: glow phase + activity/hint text (null = hidden). */
  onUi?: (phase: VoiceGlowPhase, activity: string | null) => void;
  /** PHASE-19 display slot: the single reply currently on screen (msg frozen
   *  or the streaming tail) — both null = the activity readout shows. */
  onSlot?: (msg: AgentMessage | null, streaming: AgentMessage | null) => void;
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
  /** The utterance being streamed to TTS (message index + TTS id). */
  private utter: { idx: number; uttId: number } | null = null;
  /** PHASE-19 display slot: pure state machine + uttId→message idx. */
  private slot: SlotState = initialSlotState;
  private uttIdx = new Map<number, number>();
  /** Sticky activity phrase (last tool call/thinking this run) — the display
   *  never blanks between phrases (0.5.30 user spec: "always something on
   *  screen"). Reset at run start; the previous final fills the gap. */
  private stickyActivity: string | null = null;
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
        // the queue, double-tap skips it (cache-only).
        if (st === "idle") this.ui = { ...this.ui, playback: "off" };
        else if (st === "paused") this.ui = { ...this.ui, playback: "paused" };
        else this.ui = { ...this.ui, playback: "on" };
        this.emitSpeak(st);
        this.paint();
      },
      // PHASE-19: an utterance fully read (or drained cache-only) advances
      // the display slot.
      onUtteranceComplete: (uttId) => {
        this.uttIdx.delete(uttId);
        this.slot = reduceSlot(this.slot, { type: "utterance_complete", uttId });
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
    } else {
      this.connecting = false;
      if (this.utter) {
        this.suppressIdx = this.utter.idx;
        this.utter = null;
      }
      this.tts.stopAndFlush();
      this.recorder.discard();
      this.slot = reduceSlot(this.slot, { type: "flush" });
      this.uttIdx.clear();
      this.stickyActivity = null;
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
    this.slot = reduceSlot(this.slot, { type: "flush" });
    this.uttIdx.clear();
    void this.opts.abortRun();
  }

  destroy(): void {
    this.unsub?.();
    this.unsub = null;
    this.tts.stopAndFlush();
    this.recorder.discard();
    this.slot = reduceSlot(this.slot, { type: "flush" });
    this.uttIdx.clear();
  }

  // ---------------------------------------------------------------- internals

  private dispatch(ev: VoiceEvent): void {
    // 0.5.30: reconcile with the LIVE TTS pipeline before reducing — the
    // gesture map must never act on stale playback flags (device bug: a
    // desynced "off" made double-tap start a recording over audible playback).
    const st = this.tts.pipelineState;
    const playback = st === "idle" ? "off" : st === "paused" ? "paused" : "on";
    if (this.ui.playback !== playback) this.ui = { ...this.ui, playback };
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
      // PHASE-19: a new session restarts the display story; close a leftover
      // utterance so its text flushes to the old session's speech.
      if (this.utter) {
        this.tts.endUtterance();
        this.utter = null;
      }
      this.slot = reduceSlot(this.slot, { type: "flush" });
      this.uttIdx.clear();
      this.stickyActivity = null;
    }
    this.session.noteContextTokens(s.contextUsage?.tokens ?? null);

    if (s.agentRunning !== this.lastRunning) {
      this.lastRunning = s.agentRunning;
      if (s.agentRunning) {
        this.connecting = false;
        // Fresh run: the phrase slot starts empty (the previous final reply
        // fills the gap until the first tool call/thinking phrase arrives).
        this.stickyActivity = null;
      }
      this.ui = reduceVoiceUi(this.ui, s.agentRunning ? "run_started" : "run_ended").ui;
    }

    if (this.mode === "voice") {
      // ---- streaming TTS: one utterance per assistant message, fed
      // incrementally (the tail's text speaks mid-run; a completed message is
      // fed whole). Complete = a later entry exists (toolResult included) or
      // the run ended — that flushes the tail.
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

      // Live turn: the streaming tail while it grows — its message lands at
      // messages.length on message_end (index-continuous) — else the last
      // completed assistant message, never crossing a user message.
      let liveIdx = -1;
      let liveText = "";
      if (s.streamingMessage && s.streamingMessage.role === "assistant") {
        liveIdx = s.messages.length;
        liveText = messageText(s.streamingMessage);
      } else {
        for (let i = s.messages.length - 1; i >= 0; i--) {
          const m = s.messages[i];
          if (m.role === "assistant") {
            liveIdx = i;
            liveText = messageText(m);
            break;
          }
          if (m.role === "user") break;
        }
      }
      if (liveIdx >= 0 && liveIdx !== this.suppressIdx) {
        if (!this.utter) {
          const id = s.entryIds[liveIdx];
          if (!id || !this.seenIds.has(id)) {
            const uttId = this.tts.beginUtterance();
            this.utter = { idx: liveIdx, uttId };
            this.uttIdx.set(uttId, liveIdx);
            this.slot = reduceSlot(this.slot, { type: "utterance_begun", uttId, idx: liveIdx });
          }
        }
        if (this.utter && this.utter.idx === liveIdx) {
          this.tts.noteText(liveText);
        }
      }
    } else {
      for (const id of s.entryIds) this.seenIds.add(id);
    }

    this.paint();
  }

  private paint(): void {
    const view = this.emitSlot();
    // Activity readout: only while the slot holds no reply ("tool calls are
    // only shown when there is currently no reply to display"), and then the
    // STICKY phrase — the display never blanks between phrases. The cap hint
    // owns the center while it is up.
    const hint =
      this.ui.capReached && this.ui.recording === "paused"
        ? "message cap reached, double tap to send"
        : null;
    const activity =
      hint ??
      (view.kind === "activity" && this.opts.store.state.agentRunning
        ? this.stickyActivity
        : null);
    this.opts.onUi?.(voicePhase(this.ui, this.ttsGlow, this.connecting), activity);
  }

  /** Resolve the display slot (0.5.30 replace-on-arrival model) and push it. */
  private emitSlot(): SlotView {
    const s = this.opts.store.state;
    const liveIdx =
      s.streamingMessage && s.streamingMessage.role === "assistant" ? s.messages.length : -1;
    const activity = currentActivity(s.messages);
    if (s.agentRunning && activity !== null) this.stickyActivity = activity;
    const view = slotView(this.slot, {
      liveIdx,
      running: s.agentRunning,
      activity: this.stickyActivity,
      lastAssistantIdx: lastAssistantIdx(s),
    });
    if (view.kind === "activity") {
      this.opts.onSlot?.(null, null);
      return view;
    }
    if (view.streaming) this.opts.onSlot?.(null, s.streamingMessage);
    else this.opts.onSlot?.(s.messages[view.idx] ?? null, null);
    return view;
  }
}

/** Last completed assistant message of the current turn (never crosses a user
 *  message) — the final response at run end. */
function lastAssistantIdx(s: { messages: AgentMessage[] }): number {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === "assistant") return i;
    if (m.role === "user") break;
  }
  return -1;
}
