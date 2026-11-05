// Mobile soft-keyboard handling.
//
// Two distinct problems, both from real-world reports:
// 1. iOS scrolls the page and clipped ancestors to reveal a focused input
//    when the keyboard opens (claude-obsidian PR #319) — that scroll shows up
//    as a giant phantom gap ABOVE the keyboard and is NOT our margin. It must
//    be undone, repeatedly (the scroll lands asynchronously).
// 2. The composer needs real clearance = the keyboard overlay. Obsidian
//    publishes --keyboard-height on :root and the keyboard draws OVER the page
//    (notetweet_obsidian PR #85) — the raw variable is the right reserve.

import { Platform } from "obsidian";

const KEYBOARD_HEIGHT_VAR = "--keyboard-height";
const INSET_VAR = "--pi-keyboard-inset";
const NAVBAR_VAR = "--pi-navbar-clearance";
const SAFE_BOTTOM_VAR = "--pi-safe-bottom";
const CANCEL_VAR = "--pi-kb-cancel";
const GAP_VAR = "--pi-kb-gap";

/** Numeric px value of the root `--keyboard-height`; 0 when empty/unparseable. */
function readKeyboardHeightPx(): number {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(KEYBOARD_HEIGHT_VAR)
    .trim();
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Height of Obsidian mobile's floating bottom navbar (0 on desktop).
 *  The `.is-mobile` element that defines --navbar-height isn't guaranteed to
 *  be body — scan the likely holders, then fall back to the documented value. */
function navbarClearancePx(): number {
  if (!Platform.isMobile) return 0;
  const holders: (Element | null)[] = [
    document.body,
    document.documentElement,
    document.querySelector(".app-container"),
  ];
  for (const el of holders) {
    if (!el) continue;
    const raw = getComputedStyle(el).getPropertyValue("--navbar-height").trim();
    const value = parseFloat(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 80; // app.css: `.is-mobile { --navbar-height: 80px }`
}

/** Undo the scroll the keyboard reveal adds to the page and any scrolled
 *  ancestor of `root` (see header). Without this, everything shifts up by the
 *  scroll amount and reads as a phantom gap above the keyboard. */
function undoKeyboardScroll(root: HTMLElement): void {
  const se = document.scrollingElement;
  if (se && (se.scrollTop !== 0 || se.scrollLeft !== 0)) {
    se.scrollTop = 0;
    se.scrollLeft = 0;
  }
  let el: HTMLElement | null = root;
  while (el) {
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      el.scrollTop = 0;
      el.scrollLeft = 0;
    }
    el = el.parentElement;
  }
}

/** Tracks the mobile soft-keyboard inset and publishes it as CSS custom
 *  properties on `root`. Returns a cleanup function. */
export function attachKeyboardInset(root: HTMLElement): () => void {
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  // All bottom-edge math happens HERE; CSS just consumes --pi-kb-gap /
  // --pi-kb-cancel. The app sizes the view to end at the keyboard but pads the
  // content bottom asynchronously (the phantom gap) — cancel = max(measured
  // padding, keyboard height) is predictive at keyboard-open and exact once
  // the padding lands. A light chase loop re-measures continuously.
  const applyVars = (): void => {
    const kb = readKeyboardHeightPx();
    const navbar = navbarClearancePx();
    const reserve = parseFloat(getComputedStyle(root).paddingBottom) || 0;
    const cancel = Math.max(reserve, kb);
    // For the body-fixed composer: distance from the SCREEN bottom.
    const composerBottom = (kb > 0 ? kb : navbar) + 6;
    // Published on :root — the fixed composer lives on document.body, outside
    // the view tree, and must inherit these.
    const target = document.documentElement.style;
    target.setProperty(CANCEL_VAR, `${cancel}px`);
    target.setProperty(GAP_VAR, `${composerBottom}px`);
    target.setProperty(INSET_VAR, `${kb}px`);
    target.setProperty(NAVBAR_VAR, `${navbar}px`);
    target.setProperty(
      SAFE_BOTTOM_VAR,
      Platform.isMobile ? "max(env(safe-area-inset-bottom), 20px)" : "0px"
    );
    // Pin continuously while the keyboard is up: iOS lands its reveal scroll
    // asynchronously (~1s late on some devices) — a one-shot undo misses it.
    if (kb > 0) undoKeyboardScroll(root);
  };

  const apply = (): void => {
    applyVars();
  };

  const chaseTimer = setInterval(applyVars, 250);
  const resizeObserver = new ResizeObserver(() => applyVars());
  resizeObserver.observe(root);

  // The reveal scroll can land after the keyboard signal — chase it a few times.
  const chaseScroll = (): void => {
    undoKeyboardScroll(root);
    const delays = [0, 50, 150, 300, 600];
    for (const ms of delays) {
      setTimeout(() => {
        if (readKeyboardHeightPx() > 0) undoKeyboardScroll(root);
      }, ms);
    }
  };

  // Primary signal: Obsidian setting --keyboard-height on the document root.
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
    characterData: true,
  });

  // Fallback signal: the visual viewport changes when the keyboard opens even
  // if the --keyboard-height variable is not (re)written.
  const viewport = window.visualViewport;
  const onViewportChange = (): void => {
    apply();
    chaseScroll();
  };
  viewport?.addEventListener("resize", onViewportChange);
  viewport?.addEventListener("scroll", onViewportChange);

  // Focusing anything inside the view triggers the reveal scroll — chase it.
  const onFocusIn = (): void => chaseScroll();
  root.addEventListener("focusin", onFocusIn);

  apply(); // baseline so the properties exist before the first signal

  return () => {
    clearInterval(chaseTimer);
    resizeObserver.disconnect();
    observer.disconnect();
    viewport?.removeEventListener("resize", onViewportChange);
    viewport?.removeEventListener("scroll", onViewportChange);
    root.removeEventListener("focusin", onFocusIn);
    if (retryTimer) clearTimeout(retryTimer);
    const target = document.documentElement.style;
    target.removeProperty(INSET_VAR);
    target.removeProperty(NAVBAR_VAR);
    target.removeProperty(SAFE_BOTTOM_VAR);
    target.removeProperty(CANCEL_VAR);
    target.removeProperty(GAP_VAR);
  };
}
