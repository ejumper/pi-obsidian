/**
 * Voice-overlay display slot (PHASE-19) — pure and total, like gesture-state.
 *
 * One reply at a time (user spec 2026-11-19/20). The priority is to show
 * RESPONSES: a response appears as soon as its text starts streaming — unless
 * the speech queue is occupied (a previous response is still being read), in
 * which case the display FOLLOWS PLAYBACK: the message being read stays until
 * its TTS finishes (or the user skips it — skip counts as finished), and the
 * next queued response takes over ("it displays as is and continues streaming
 * in" when it reaches the queue top mid-generation).
 *
 * Lifecycle rules:
 *   - intermediate responses clear when read → the caller paints the current
 *     action (tool call / thinking) in the gap;
 *   - the final response of a run is STICKY until the next run starts — with
 *     the carve-out that a mid-read final clears when its read completes
 *     ("being read wins"), which falls out of the generation counter;
 *   - stopped finals stay on screen (they are "the response on screen" for
 *     tap-to-repeat — see PHASE-17);
 *   - tool calls show only when there is no response to display (view
 *     "activity").
 *
 * Message identity: plain `messages[]` indices, where the in-flight streaming
 * tail is the virtual index `messages.length` (it lands there on message_end —
 * index-continuous by construction).
 */

export interface SlotPending {
  /** TTS utterance id (FIFO order = playback order). */
  uttId: number;
  idx: number;
}

export interface SlotState {
  /** Begun speech utterances not yet read out. */
  pending: SlotPending[];
  /** Sticky final of the last-ended run (-1 = none). */
  finalIdx: number;
  /** Run generation: bumped on run_started; a final is sticky only within its own. */
  gen: number;
  finalGen: number;
  /** Last message cleared (read/skipped) — never re-shown by the stream rule. */
  clearedIdx: number;
}

export type SlotView =
  | { kind: "message"; idx: number; streaming: boolean }
  | { kind: "activity" };

export type SlotEvent =
  | { type: "run_started" }
  | { type: "run_ended"; finalIdx: number }
  | { type: "utterance_begun"; uttId: number; idx: number }
  | { type: "utterance_complete"; uttId: number }
  /** stopAndFlush: queued speech is gone (stop run / voice off). */
  | { type: "flush" }
  | { type: "session_reset" };

export const initialSlotState: SlotState = {
  pending: [],
  finalIdx: -1,
  gen: 0,
  finalGen: -1,
  clearedIdx: -1,
};

export function reduceSlot(
  state: SlotState,
  ev: SlotEvent,
): SlotState {
  switch (ev.type) {
    case "run_started":
      return { ...state, gen: state.gen + 1 };
    case "run_ended":
      return { ...state, finalIdx: ev.finalIdx, finalGen: state.gen };
    case "utterance_begun":
      if (state.pending.some((p) => p.uttId === ev.uttId)) return state;
      return { ...state, pending: [...state.pending, { uttId: ev.uttId, idx: ev.idx }] };
    case "utterance_complete": {
      const i = state.pending.findIndex((p) => p.uttId === ev.uttId);
      if (i === -1) return state; // unknown (non-voice utterance) — not ours
      const entry = state.pending[i];
      const pending = [...state.pending.slice(0, i), ...state.pending.slice(i + 1)];
      // Only the QUEUE HEAD advances the display when it finishes; a later
      // completion (defensive — completion is FIFO-ordered) just drops out.
      const wasHead = i === 0;
      const sticky = entry.idx === state.finalIdx && state.finalGen === state.gen;
      return {
        ...state,
        pending,
        clearedIdx: wasHead && !sticky ? entry.idx : state.clearedIdx,
      };
    }
    case "flush":
      return { ...state, pending: [] };
    case "session_reset":
      return { ...initialSlotState, gen: state.gen };
    default:
      return state;
  }
}

/**
 * Resolve the slot for the current stream position. `liveIdx` = the index of
 * the message currently streaming in (virtual tail = messages.length), or -1
 * when nothing is generating.
 */
export function slotView(state: SlotState, liveIdx: number): SlotView {
  const head = state.pending[0];
  if (head) return { kind: "message", idx: head.idx, streaming: head.idx === liveIdx };
  // Stream-in rule: a fresh response shows the moment text starts flowing.
  if (liveIdx >= 0 && liveIdx !== state.clearedIdx)
    return { kind: "message", idx: liveIdx, streaming: true };
  // Sticky final of the current run.
  if (
    state.finalIdx >= 0 &&
    state.finalGen === state.gen &&
    state.finalIdx !== state.clearedIdx
  )
    return { kind: "message", idx: state.finalIdx, streaming: false };
  return { kind: "activity" };
}
