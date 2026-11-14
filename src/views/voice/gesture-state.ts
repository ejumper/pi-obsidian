/**
 * Voice-mode gesture reducer (PHASE-14 §1.2) — pure and total.
 *
 * Orthogonal flags rather than one state enum, because overlaps are real (a run can be
 * producing spoken mid-run messages while a follow-up is being recorded) and each input
 * resolves by its own priority:
 *   - single tap = universal pause/play of whatever is active (recording beats playback)
 *   - double tap = record / send (follow-ups queue for the next turn, typing parity)
 *   - long press = discard recording > stop-run countdown (3…2…1, ~4 s total hold) > replay
 * Timings (320 ms double window, 1 000 ms long press, 12 px drift cancel) live in the UI
 * layer; this machine only sees the resolved events.
 */

export interface VoiceUi {
  recording: "off" | "on" | "paused";
  playback: "off" | "on" | "paused";
  runActive: boolean;
  /** stop-run countdown armed by long-press; release or completion clears it. */
  countdown: boolean;
}

export type VoiceEvent =
  | "tap"
  | "double_tap"
  | "long_press"
  | "long_release"
  | "hold_cancel"
  | "countdown_done"
  | "run_started"
  | "run_ended"
  | "playback_started"
  | "playback_ended";

export type VoiceAction =
  | "start_recording"
  | "stop_send"
  | "pause_recording"
  | "resume_recording"
  | "discard_recording"
  | "pause_playback"
  | "resume_playback"
  | "replay"
  | "stop_playback_start_recording"
  | "show_stop_countdown"
  | "cancel_stop_countdown"
  | "stop_run"
  | null;

export const initialVoiceUi: VoiceUi = {
  recording: "off",
  playback: "off",
  runActive: false,
  countdown: false,
};

export function reduceVoiceUi(
  ui: VoiceUi,
  ev: VoiceEvent,
): { ui: VoiceUi; action: VoiceAction } {
  switch (ev) {
    case "run_started":
      return { ui: { ...ui, runActive: true }, action: null };
    case "run_ended":
      return { ui: { ...ui, runActive: false, countdown: false }, action: null };
    case "playback_started":
      return { ui: { ...ui, playback: "on" }, action: null };
    case "playback_ended":
      return { ui: { ...ui, playback: "off" }, action: null };
    case "countdown_done":
      if (!ui.countdown) return { ui, action: null };
      return { ui: { ...ui, countdown: false }, action: "stop_run" };
    case "long_release":
      // Walkie-talkie (beta3 remap): a clean release after a hold sends the
      // recording — the hold started it, the release completes it.
      if (ui.recording !== "off")
        return { ui: { ...ui, recording: "off" }, action: "stop_send" };
      if (!ui.countdown) return { ui, action: null };
      return { ui: { ...ui, countdown: false }, action: "cancel_stop_countdown" };
    case "hold_cancel":
      // Slide-off cancels (walkie-talkie standard): discard the recording.
      if (ui.recording !== "off")
        return { ui: { ...ui, recording: "off" }, action: "discard_recording" };
      if (ui.countdown) return { ui: { ...ui, countdown: false }, action: "cancel_stop_countdown" };
      return { ui, action: null };
    case "tap":
      if (ui.recording === "on")
        return { ui: { ...ui, recording: "paused" }, action: "pause_recording" };
      if (ui.recording === "paused")
        return { ui: { ...ui, recording: "on" }, action: "resume_recording" };
      if (ui.playback === "on")
        return { ui: { ...ui, playback: "paused" }, action: "pause_playback" };
      if (ui.playback === "paused")
        return { ui: { ...ui, playback: "on" }, action: "resume_playback" };
      // Nothing active: tap = play (replay the message on screen) — the
      // universal pause/play rule. A live run has nothing to replay to.
      return { ui, action: ui.runActive ? null : "replay" };
    case "double_tap":
      if (ui.recording !== "off")
        return { ui: { ...ui, recording: "off" }, action: "stop_send" };
      if (ui.playback !== "off")
        return {
          ui: { ...ui, playback: "off", recording: "on", countdown: false },
          action: "stop_playback_start_recording",
        };
      return {
        ui: { ...ui, recording: "on", countdown: false },
        action: "start_recording",
      };
    case "long_press":
      // Hold-to-talk (beta3 remap): holding RECORDS — unambiguous input for a
      // car. Release sends (long_release), slide-off cancels (hold_cancel).
      if (ui.recording !== "off")
        return { ui: { ...ui, recording: "off" }, action: "discard_recording" };
      if (ui.playback !== "off")
        return {
          ui: { ...ui, playback: "off", recording: "on", countdown: false },
          action: "stop_playback_start_recording",
        };
      return {
        ui: { ...ui, recording: "on", countdown: false },
        action: "start_recording",
      };
    default:
      return { ui, action: null };
  }
}

/**
 * Phase for the glow state machine (colors × phases ported verbatim from pi-voice-chat:
 * red pulse recording / red steady paused / white pulse working / green audio-driven
 * playing / green steady paused / off idle). "connecting" is between send and run start —
 * the UI layer ORs it in around `stop_send → run_started`.
 */
export type VoiceGlowPhase =
  | "idle"
  | "recording"
  | "recording_paused"
  | "working"
  | "playing"
  | "playing_paused";

export function voicePhase(ui: VoiceUi): VoiceGlowPhase {
  if (ui.recording === "on") return "recording";
  if (ui.recording === "paused") return "recording_paused";
  if (ui.runActive) return "working";
  if (ui.playback === "on") return "playing";
  if (ui.playback === "paused") return "playing_paused";
  return "idle";
}
