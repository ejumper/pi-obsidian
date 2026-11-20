/**
 * Voice-mode gesture reducer (PHASE-17) — pure and total.
 *
 * The touch actions apply to THE GLOW: the glow color is the gesture-family
 * selector — red = recording actions, green = TTS actions, white = run actions,
 * no glow = repeat / record / none. To record, the user "removes the glow"
 * first (green → double-tap; white → long-press), then double-taps.
 *
 * Orthogonal flags rather than one state enum (overlaps are real — green TTS
 * and a white run coexist; each input resolves by its own priority):
 *   - single tap   = pause/resume of the active audio (recording beats playback);
 *                    idle = repeat the response on screen
 *   - double tap   = finish without losing anything: send the recording, or
 *                    skip the current TTS utterance (it finishes synthesizing
 *                    into the replay cache but never plays)
 *   - long press   = the destructive action: discard the recording, else stop
 *                    the run (fires at the hold threshold — the old 3…2…1
 *                    countdown is retired; the STOP button is the safe path)
 *
 * No follow-up recordings (Gap D, option #1): recording starts only from full
 * idle, so "recording while TTS plays" is structurally unreachable.
 *
 * Timings (320 ms double window, 1 000 ms long press, 12 px drift cancel) live
 * in the UI layer; this machine only sees the resolved events.
 */

export interface VoiceUi {
  recording: "off" | "on" | "paused";
  playback: "off" | "on" | "paused";
  runActive: boolean;
  /** STT processing after send — the red chaser; all gestures are inert. */
  sttWait: boolean;
  /** 30 s of recording time left — the red 1s/1s blink. */
  capWarning: boolean;
  /** Hard cap reached: paused ABSOLUTELY — tap cannot resume. */
  capReached: boolean;
  /** Speech registered in the current recording (send guard + silence policy). */
  hasAudio: boolean;
}

export type VoiceEvent =
  | "tap"
  | "double_tap"
  | "long_press"
  | "long_release"
  | "hold_cancel"
  | "run_started"
  | "run_ended"
  | "playback_started"
  | "playback_ended"
  | "stt_ended"
  | "cap_warning"
  | "cap_reached"
  | "audio_registered"
  | "silence_pause"
  | "silence_discard";

export type VoiceAction =
  | "start_recording"
  | "stop_send"
  | "pause_recording"
  | "resume_recording"
  | "discard_recording"
  | "pause_playback"
  | "resume_playback"
  | "replay"
  | "skip_playback"
  | "stop_run"
  | null;

export const initialVoiceUi: VoiceUi = {
  recording: "off",
  playback: "off",
  runActive: false,
  sttWait: false,
  capWarning: false,
  capReached: false,
  hasAudio: false,
};

const clearRecording = {
  recording: "off" as const,
  capWarning: false,
  capReached: false,
  hasAudio: false,
};

export function reduceVoiceUi(
  ui: VoiceUi,
  ev: VoiceEvent,
): { ui: VoiceUi; action: VoiceAction } {
  switch (ev) {
    case "run_started":
      return { ui: { ...ui, runActive: true, sttWait: false }, action: null };
    case "run_ended":
      return { ui: { ...ui, runActive: false }, action: null };
    case "playback_started":
      return { ui: { ...ui, playback: "on" }, action: null };
    case "playback_ended":
      return { ui: { ...ui, playback: "off" }, action: null };
    case "stt_ended":
      return { ui: { ...ui, sttWait: false }, action: null };
    case "cap_warning":
      return { ui: { ...ui, capWarning: true }, action: null };
    case "audio_registered":
      return { ui: { ...ui, hasAudio: true }, action: null };
    case "cap_reached":
      if (ui.recording !== "on") return { ui, action: null };
      // Absolute: paused for good — only send or discard proceed. The blink
      // gives way to red static + the hint.
      return {
        ui: { ...ui, recording: "paused", capWarning: false, capReached: true },
        action: "pause_recording",
      };
    case "silence_pause":
      if (ui.recording !== "on") return { ui, action: null };
      return { ui: { ...ui, recording: "paused" }, action: "pause_recording" };
    case "silence_discard":
      if (ui.recording === "off") return { ui, action: null };
      return { ui: { ...ui, ...clearRecording }, action: "discard_recording" };
    case "long_release":
      // Long-press fires at threshold now — release has nothing to cancel.
      return { ui, action: null };
    case "hold_cancel":
      // Slide-off before the threshold cancels the pending hold. Destructive
      // actions need the full hold (the old slide-off-discard legacy is gone).
      return { ui, action: null };
    case "tap":
      if (ui.recording === "on")
        return { ui: { ...ui, recording: "paused" }, action: "pause_recording" };
      if (ui.recording === "paused")
        // Cap is absolute — no resume by tap.
        if (ui.capReached) return { ui, action: null };
        else return { ui: { ...ui, recording: "on" }, action: "resume_recording" };
      if (ui.sttWait) return { ui, action: null };
      if (ui.playback === "on")
        return { ui: { ...ui, playback: "paused" }, action: "pause_playback" };
      if (ui.playback === "paused")
        return { ui: { ...ui, playback: "on" }, action: "resume_playback" };
      // Idle: repeat the response on screen (no-op when there is none).
      return { ui, action: ui.runActive ? null : "replay" };
    case "double_tap":
      if (ui.recording !== "off") {
        // Finish & send — nothing to send = nothing happens.
        if (!ui.hasAudio) return { ui, action: null };
        return {
          ui: { ...ui, ...clearRecording, sttWait: true },
          action: "stop_send",
        };
      }
      if (ui.sttWait) return { ui, action: null };
      if (ui.playback !== "off")
        // Stop/skip: the utterance finishes synthesizing into the replay
        // cache but never plays; the next queued message starts.
        return { ui: { ...ui, playback: "off" }, action: "skip_playback" };
      // White (run) = nothing — no follow-up recordings. Record only from
      // full idle ("remove the glow, then double tap").
      if (ui.runActive) return { ui, action: null };
      return {
        ui: {
          ...ui,
          recording: "on",
          capWarning: false,
          capReached: false,
          hasAudio: false,
        },
        action: "start_recording",
      };
    case "long_press":
      if (ui.recording !== "off")
        return { ui: { ...ui, ...clearRecording }, action: "discard_recording" };
      if (ui.sttWait) return { ui, action: null };
      // Destructive: "you are not going to get the rest of this model's run".
      if (ui.runActive) return { ui, action: "stop_run" };
      return { ui, action: null };
    default:
      return { ui, action: null };
  }
}

/**
 * Phase for the glow state machine (colors × phases ported verbatim from
 * pi-voice-chat). Precedence: red > green > white > off:
 *   recording (red, breath) > recording_warning (red 1s/1s blink) >
 *   recording_paused (red static) > stt_waiting (red chaser) >
 *   playing (green visualizer) > playing_paused (green static) >
 *   synthesizing (green chaser) > connecting (white chaser) >
 *   working (white breath) > idle (off).
 * `tts` is the TTS pipeline state; when omitted, the legacy ui.playback flags
 * stand in (harness/back-compat).
 */
export type VoiceGlowPhase =
  | "idle"
  | "recording"
  | "recording_warning"
  | "recording_paused"
  | "stt_waiting"
  | "connecting"
  | "working"
  | "synthesizing"
  | "playing"
  | "playing_paused";

/** TTS pipeline state for the glow (0.5.2 precedence: green breath > green
 *  chase > white breath — see voicePhase). */
export type TtsGlow = "off" | "synthesizing" | "playing" | "paused";

export function voicePhase(
  ui: VoiceUi,
  tts?: TtsGlow,
  connecting = false,
): VoiceGlowPhase {
  const t: TtsGlow =
    tts ??
    (ui.playback === "on" ? "playing" : ui.playback === "paused" ? "paused" : "off");
  if (ui.recording === "on")
    return ui.capWarning ? "recording_warning" : "recording";
  if (ui.recording === "paused") return "recording_paused";
  if (ui.sttWait) return "stt_waiting";
  if (t === "playing") return "playing";
  if (t === "paused") return "playing_paused";
  if (t === "synthesizing") return "synthesizing";
  if (connecting) return "connecting";
  if (ui.runActive) return "working";
  return "idle";
}
