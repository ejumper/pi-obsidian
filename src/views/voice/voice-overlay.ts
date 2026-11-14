/**
 * Voice-mode overlay DOM (PHASE-14 §1.2) — the dumb view layer that covers the
 * chat transcript while voice mode is on (the transcript stays mounted
 * underneath). It owns DOM only: pane geometry, the glow state machine (colors ×
 * modes ported from pi-voice-chat's app/chat/chat.css), the stop-run countdown
 * text, the last-message render through the existing React transcript renderer,
 * and the driving-tested pointer gesture set (320 ms double-tap window, 1 000 ms
 * long press, 12 px drift cancel — the /chat timings). Every decision lives in
 * VoiceController: this class reports raw gestures upward and paints what it is
 * told. No Obsidian imports — plain DOM plus the project's own modules.
 *
 * Geometry: the pane is prepended INSIDE the transcript container with
 * `position: absolute; inset: 0` (the container is made `position: relative`),
 * so it covers the container's box exactly. An abspos child of a SCROLL
 * container scrolls with the content though — the transcript is usually pinned
 * to the bottom — so a scroll mirror keeps the pane over the *visible* area via
 * translateY(scrollTop). The glow lives in an oversized box (chat parity: the
 * conic mask must never clip the halo spill) that the pane's own overflow
 * clips — neither may grow the transcript's scrollable area. The pane is
 * pointer-events: none except the gesture surface (with 28px side gutters for
 * panel swipes) and the message column, so edge swipes reach the panels.
 */

import type { VoiceGlowPhase } from "./gesture-state";
import type { AgentMessage } from "../../api/types";
import { stripMessageVoiceBlocks } from "./banner-state";
import { computeTranscriptUnits } from "../message-display";
import { TranscriptRenderer } from "../react/Transcript";
import { getMarkdownContext } from "../react/pi-web/markdown-context";

export interface VoiceOverlayHandlers {
  onTap(): void;
  onDoubleTap(): void;
  onLongPress(): void;
  onLongRelease(): void;
}

export interface VoiceOverlayOptions {
  container: HTMLElement;          // the transcript container element to overlay
  handlers: VoiceOverlayHandlers;
  onFirstGesture?: () => void;     // fire once on the first pointer interaction (autoplay unlock)
  apiBase: string;                 // passed through to the transcript renderer
  cwd: string;
  sessionId?: string;
}

/** Gesture timings ported from pi-voice-chat's driving UI. */
const DOUBLE_TAP_MS = 320;
const LONG_PRESS_MS = 1000;
/** Drift from the pointerdown origin that cancels the long press AND turns the
 *  gesture into a swipe (scroll / panel gesture — never a tap on release). */
const DRIFT_PX = 12;

const GLOW_PHASES: readonly VoiceGlowPhase[] = [
  "idle",
  "recording",
  "recording_paused",
  "working",
  "playing",
  "playing_paused",
];

/** TranscriptRenderer's ctx type without importing obsidian (it travels along
 *  transitively through Transcript.tsx). */
type RendererCtx = ConstructorParameters<typeof TranscriptRenderer>[1];

function div(cls: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  return el;
}

export class VoiceOverlay {
  readonly el: HTMLElement;

  private readonly opts: VoiceOverlayOptions;
  private readonly handlers: VoiceOverlayHandlers;
  private readonly gesturesEl: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly countdownEl: HTMLElement;
  private readonly renderer: TranscriptRenderer;
  /** Container's inline position before we made it the pane's containing block. */
  private readonly prevContainerPosition: string;

  // ---- gesture tracking (one active pointer) ----
  private pointerId: number | null = null;
  private downX = 0;
  private downY = 0;
  private swiped = false;
  private longFired = false;
  private longTimer: number | null = null;
  private tapTimer: number | null = null;
  private firstGestureFired = false;
  private destroyed = false;

  constructor(opts: VoiceOverlayOptions) {
    this.opts = opts;
    this.handlers = opts.handlers;

    // ---- DOM: pane > glow (rings + arc) / gestures(> msg) / countdown ----
    const pane = div("pi-voice-pane pi-voice-phase-idle");

    const glow = div("pi-voice-glow");
    const edge = div("pi-voice-glow-edge");
    const wide = div("pi-voice-glow-layer pi-voice-glow-layer--wide");
    wide.append(div("pi-voice-glow-ring"));
    const core = div("pi-voice-glow-layer pi-voice-glow-layer--core");
    core.append(div("pi-voice-glow-ring"));
    edge.append(wide, core);
    const arc = div("pi-voice-glow-arc");
    const arcLayer = div("pi-voice-glow-layer pi-voice-glow-layer--arc");
    arcLayer.append(div("pi-voice-glow-ring"));
    arc.append(arcLayer);
    glow.append(edge, arc);

    const gestures = div("pi-voice-gestures");
    const msg = div("pi-voice-msg");
    gestures.append(msg);

    const countdown = div("pi-voice-countdown");

    pane.append(glow, gestures, countdown);
    this.el = pane;
    this.gesturesEl = gestures;
    this.msgEl = msg;
    this.countdownEl = countdown;

    // ---- containment: pane covers the container exactly ----
    const container = opts.container;
    this.prevContainerPosition = container.style.position;
    const pos = getComputedStyle(container).position;
    if (pos === "static" || pos === "") container.style.position = "relative";
    container.prepend(pane);
    container.addEventListener("scroll", this.onContainerScroll);
    this.syncPosition();

    // ---- gestures: pointerdown on the surface, move/up/cancel on WINDOW.
    // No setPointerCapture: WebKit/iOS loses pointerup under capture on touch
    // pointers, which wedges the tracker (pointerId never resets → every later
    // tap is ignored). Window-level listeners keep drags leaving the surface
    // resolving correctly without capture.
    gestures.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerCancel);

    // ---- last-message render (ONE React root; the banner stays stripped) ----
    // The markdown context is a module global the view's own TranscriptRenderer
    // set at build time — pass it through rather than clobber it (a null stub
    // would blank markdown everywhere, both here and in the transcript).
    this.renderer = new TranscriptRenderer(
      this.msgEl,
      getMarkdownContext() ?? ({ sourcePath: "" } as unknown as RendererCtx),
    );
  }

  setVisible(on: boolean): void {
    if (this.destroyed) return;
    this.el.classList.toggle("pi-voice-visible", on);
    // Re-anchor on show: the transcript may have scrolled while hidden.
    if (on) this.syncPosition();
  }

  /** Glow state machine: one `pi-voice-phase-<phase>` class on the pane; the
   *  stylesheet carries the color × mode mapping (chat parity). */
  setPhase(phase: VoiceGlowPhase): void {
    for (const p of GLOW_PHASES) this.el.classList.remove(`pi-voice-phase-${p}`);
    this.el.classList.add(`pi-voice-phase-${phase}`);
  }

  /** null hides; 3/2/1 shows "Stopping run in 3…". The controller ticks it —
   *  the gesture surface never completes or cancels anything itself, it only
   *  reports long_release when the pointer lifts. */
  setCountdown(seconds: number | null): void {
    if (this.destroyed) return;
    if (seconds === null) {
      this.countdownEl.classList.remove("pi-voice-countdown-on");
      this.countdownEl.textContent = "";
      return;
    }
    this.countdownEl.textContent = `Stopping run in ${seconds}…`;
    this.countdownEl.classList.add("pi-voice-countdown-on");
  }

  /** Last completed message + the streaming tail — the ONLY things in the units
   *  array; both pass through stripMessageVoiceBlocks so the in-band
   *  `<voice-mode>` banner is invisible here (the whole point of the strip). */
  setLastMessage(msg: AgentMessage | null, streaming: AgentMessage | null): void {
    if (this.destroyed) return;
    this.renderer.update({
      units: computeTranscriptUnits(
        msg ? [stripMessageVoiceBlocks(msg)] : [],
        streaming !== null,
      ),
      streaming: streaming ? stripMessageVoiceBlocks(streaming) : null,
      modelNames: {},
      cwd: this.opts.cwd,
      sessionId: this.opts.sessionId,
      apiBase: this.opts.apiBase,
      onFork: async () => null,
      onNavigate: () => {},
      onEditContent: () => {},
      onRendered: () => {},
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const container = this.opts.container;
    container.removeEventListener("scroll", this.onContainerScroll);
    this.gesturesEl.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    if (this.longTimer !== null) window.clearTimeout(this.longTimer);
    if (this.tapTimer !== null) window.clearTimeout(this.tapTimer);
    this.longTimer = null;
    this.tapTimer = null;
    this.renderer.unmount();
    this.el.remove();
    container.style.position = this.prevContainerPosition;
  }

  // ------------------------------------------------------------------ geometry

  /** The abspos pane sits at the content origin of the scroll container —
   *  mirror the scroll so it keeps covering the visible area. */
  private readonly onContainerScroll = (): void => this.syncPosition();

  private syncPosition(): void {
    const top = this.opts.container.scrollTop;
    this.el.style.transform = top > 0 ? `translateY(${top}px)` : "";
  }

  // ------------------------------------------------------------------ gestures

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (this.destroyed || e.button !== 0 || this.pointerId !== null) return;
    // Autoplay unlock hook: exactly once, on the first pointer interaction.
    if (!this.firstGestureFired) {
      this.firstGestureFired = true;
      try {
        this.opts.onFirstGesture?.();
      } catch {
        // autoplay unlock must never take the gesture path down
      }
    }
    // TEMP breadcrumbs for the iOS gesture spike — remove once validated on device.
    console.log("[pi-voice] down", e.pointerId);
    // Interactive message content (links, buttons, fields) keeps its own clicks —
    // a tap there must not also be a voice gesture (chat's [data-ui] exclusion).
    const target = e.target;
    if (target instanceof Element && target.closest("a, button, input, textarea, select")) return;
    this.pointerId = e.pointerId;
    this.downX = e.clientX;
    this.downY = e.clientY;
    this.swiped = false;
    this.longFired = false;
    if (this.longTimer !== null) window.clearTimeout(this.longTimer);
    this.longTimer = window.setTimeout(() => {
      this.longTimer = null;
      if (this.pointerId === null || this.swiped) return;
      this.longFired = true;
      this.handlers.onLongPress();
    }, LONG_PRESS_MS);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId || this.longFired) return;
    if (Math.hypot(e.clientX - this.downX, e.clientY - this.downY) > DRIFT_PX) {
      this.swiped = true;
      if (this.longTimer !== null) {
        window.clearTimeout(this.longTimer);
        this.longTimer = null;
      }
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    console.log(
      "[pi-voice] up",
      e.pointerId,
      this.longFired ? "long" : this.swiped ? "swipe" : this.tapTimer !== null ? "double" : "tap-pending",
    );
    if (this.longTimer !== null) {
      window.clearTimeout(this.longTimer);
      this.longTimer = null;
    }
    if (this.longFired) {
      // Held: the release reports long_release instead of any tap logic —
      // the controller cancels (or has already consumed) the countdown there.
      this.longFired = false;
      this.handlers.onLongRelease();
      return;
    }
    if (this.swiped) return; // scroll / panel gesture, never a tap
    if (this.tapTimer !== null) {
      // Second pointerup inside the 320 ms window: cancel the pending single
      // tap and fire the double tap.
      window.clearTimeout(this.tapTimer);
      this.tapTimer = null;
      this.handlers.onDoubleTap();
      return;
    }
    // First clean tap: the SINGLE tap is scheduled at the window's end — a
    // second pointerup before then turns it into a double tap instead.
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = null;
      this.handlers.onTap();
    }, DOUBLE_TAP_MS);
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    console.log("[pi-voice] cancel", e.pointerId);
    this.pointerId = null;
    if (this.longTimer !== null) {
      window.clearTimeout(this.longTimer);
      this.longTimer = null;
    }
    // A cancelled gesture reports nothing; a tap already scheduled by an
    // earlier completed pointerup keeps its own window.
  };

}
