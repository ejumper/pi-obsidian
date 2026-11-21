/**
 * Voice-overlay display slot (PHASE-19, reworked 0.5.30 after device feedback)
 * — pure and total, like gesture-state.
 *
 * The rule the user refined: there should basically ALWAYS be something on
 * screen (tool call / "thinking" / intermediate reply / final reply), and
 * content stays until something else replaces it ("tool calls/'thinking' stay
 * on until there is something else to show"). A final reply "shouldn't
 * disappear at all until a new run starts" — and even then it is REPLACED by
 * the new run's content, never blanked.
 *
 * That collapses the machine to replace-on-arrival over one priority chain:
 *
 *   1. the reply at the head of the speech queue (being read — frozen, or
 *      streaming live if it is still generating: "displays as is and continues
 *      streaming in");
 *   2. the streaming reply (a fresh response shows the moment text flows);
 *   3. the current activity phrase (tool call / thinking) while a run is
 *      active — sticky in the caller, so gaps between phrases never blank;
 *   4. the last completed assistant message (the final reply — sticky until a
 *      newer reply replaces it; an intermediate that was read simply stays
 *      when nothing else has arrived yet, per "always something on screen");
 *   5. nothing (fresh session).
 *
 * The only queue bookkeeping needed is `pending`: begun speech utterances not
 * yet read out (skipped counts as read — a skip drains cache-only). Everything
 * else derives live from the store, so the event races of the first
 * implementation (final captured before its tail landed, generation counters
 * clearing mid-read finals) cannot exist.
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
  /** Begun speech utterances not yet read out (head = what is being read). */
  pending: SlotPending[];
}

export type SlotView =
  | { kind: "message"; idx: number; streaming: boolean }
  | { kind: "activity" };

export type SlotEvent =
  | { type: "utterance_begun"; uttId: number; idx: number }
  | { type: "utterance_complete"; uttId: number }
  /** stopAndFlush: queued speech is gone (stop run / voice off / session switch). */
  | { type: "flush" };

export const initialSlotState: SlotState = { pending: [] };

export function reduceSlot(state: SlotState, ev: SlotEvent): SlotState {
  switch (ev.type) {
    case "utterance_begun":
      if (state.pending.some((p) => p.uttId === ev.uttId)) return state;
      return { ...state, pending: [...state.pending, { uttId: ev.uttId, idx: ev.idx }] };
    case "utterance_complete": {
      const i = state.pending.findIndex((p) => p.uttId === ev.uttId);
      if (i === -1) return state; // unknown (replay pass / read-aloud) — not ours
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
  /** The message currently streaming in (virtual tail index), or -1. */
  liveIdx: number;
  /** Run in progress (activity phrases only count while it is). */
  running: boolean;
  /** Sticky activity phrase (last tool call / thinking this run), or null. */
  activity: string | null;
  /** Last completed assistant message (the final reply), or -1. */
  lastAssistantIdx: number;
}

export function slotView(state: SlotState, ctx: SlotContext): SlotView {
  // 1 — the reply being read wins (frozen, or streaming live mid-generation).
  const head = state.pending[0];
  if (head) return { kind: "message", idx: head.idx, streaming: head.idx === ctx.liveIdx };
  // 2 — a fresh response shows the moment text starts flowing.
  if (ctx.liveIdx >= 0) return { kind: "message", idx: ctx.liveIdx, streaming: true };
  // 3 — the current action (sticky phrase) while the run works.
  if (ctx.running && ctx.activity !== null) return { kind: "activity" };
  // 4 — the last reply stays on screen until something replaces it.
  if (ctx.lastAssistantIdx >= 0)
    return { kind: "message", idx: ctx.lastAssistantIdx, streaming: false };
  // 5 — nothing to show (fresh session).
  return { kind: "activity" };
}
