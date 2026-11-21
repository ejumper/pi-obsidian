/**
 * Voice-overlay display slot (PHASE-19 / 0.5.31 rework) — pure and total.
 *
 * The rule: there should basically ALWAYS be something on screen (tool call /
 * "thinking" / intermediate reply / final reply) and content stays until
 * something else replaces it. Priority chain:
 *
 *   1. the reply at the head of the speech queue (being read — frozen, or the
 *      streaming tail while it still generates: "displays as is and continues
 *      streaming in");
 *   2. the streaming reply (a fresh response shows the moment text flows);
 *   3. the current activity phrase (tool call / thinking) while a run is
 *      active (sticky in the caller — gaps between phrases never blank);
 *   4. the last completed assistant reply (stays until replaced);
 *   5. nothing (fresh session).
 *
 * Queue entries carry the message index ONLY ONCE THE MESSAGE HAS LANDED.
 * While the reply is the in-flight streaming tail the index is inherently
 * unknown — entries carry -1 and the caller shows the live tail. (0.5.31: the
 * first implementation keyed the tail by `messages.length` at begin time;
 * entries appended mid-stream — staggered parallel tool results — drifted
 * that index, split the utterance mid-message and dereferenced a stale
 * message: black screens, finals "disappearing", mid-message re-renders.)
 *
 * Message identity: `messages[]` indices (stable for landed entries — the
 * store only appends), with -1 meaning "the streaming tail".
 */

export interface SlotPending {
  /** TTS utterance id (FIFO order = playback order). */
  uttId: number;
  /** Message index once landed; -1 while it is still the streaming tail. */
  idx: number;
}

export interface SlotState {
  /** Begun speech utterances not yet read out (head = what is being read). */
  pending: SlotPending[];
}

export type SlotView =
  | { kind: "message"; idx: number; streaming: boolean }
  | { kind: "activity" };

export type SlotEvent =
  | { type: "utterance_begun"; uttId: number; idx: number }
  /** The tail landed — the entry now knows its message index. */
  | { type: "utterance_landed"; uttId: number; idx: number }
  | { type: "utterance_complete"; uttId: number }
  /** stopAndFlush: queued speech is gone (stop run / voice off / switch). */
  | { type: "flush" };

export const initialSlotState: SlotState = { pending: [] };

export function reduceSlot(state: SlotState, ev: SlotEvent): SlotState {
  switch (ev.type) {
    case "utterance_begun":
      if (state.pending.some((p) => p.uttId === ev.uttId)) return state;
      return { ...state, pending: [...state.pending, { uttId: ev.uttId, idx: ev.idx }] };
    case "utterance_landed": {
      // Index repair for a tail entry (audio still to play). Unknown ids are
      // inert — replay passes and read-alouds are not ours.
      const i = state.pending.findIndex((p) => p.uttId === ev.uttId);
      if (i === -1) return state;
      const pending = [...state.pending];
      pending[i] = { ...pending[i], idx: ev.idx };
      return { ...state, pending };
    }
    case "utterance_complete": {
      const i = state.pending.findIndex((p) => p.uttId === ev.uttId);
      if (i === -1) return state;
      return {
        ...state,
        pending: [...state.pending.slice(0, i), ...state.pending.slice(i + 1)],
      };
    }
    case "flush":
      return { ...state, pending: [] };
    default:
      return state;
  }
}

export interface SlotContext {
  /** The in-flight tail is streaming AND displayable (has reply text). */
  tailStreaming: boolean;
  /** Run in progress (activity phrases only count while it is). */
  running: boolean;
  /** Sticky activity phrase (last tool call / thinking this run), or null. */
  activity: string | null;
  /** Last displayable assistant reply ("the final"), or -1. */
  lastAssistantIdx: number;
}

export function slotView(state: SlotState, ctx: SlotContext): SlotView {
  // 1 — the reply being read wins (frozen once landed, or the live tail).
  const head = state.pending[0];
  if (head) return { kind: "message", idx: head.idx, streaming: head.idx === -1 };
  // 2 — a fresh response shows the moment reply text starts flowing.
  if (ctx.tailStreaming) return { kind: "message", idx: -1, streaming: true };
  // 3 — the current action (sticky phrase) while the run works.
  if (ctx.running && ctx.activity !== null) return { kind: "activity" };
  // 4 — the last reply stays on screen until something replaces it.
  if (ctx.lastAssistantIdx >= 0)
    return { kind: "message", idx: ctx.lastAssistantIdx, streaming: false };
  // 5 — nothing to show (fresh session / thinking-only tail).
  return { kind: "activity" };
}
