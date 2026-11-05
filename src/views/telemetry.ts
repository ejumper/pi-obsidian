// Keyboard telemetry overlay — temporary diagnostic for the double-reservation
// bug (PLAN/PHASES/PHASE-6 phone fixes). Paints the raw geometry so one phone
// screenshot settles which layer is reserving space.

export interface TelemetryReadout {
  innerHeight: number;
  vvOffsetTop: number;
  vvHeight: number;
  composerBottom: number;
  rootBottom: number;
  pageScrollTop: number;
  rootScrollTop: number;
  keyboardVar: string;
  safeBottomVar: string;
  composerMargin: string;
}

export function readTelemetry(root: HTMLElement, composer: HTMLElement): TelemetryReadout {
  const vv = window.visualViewport;
  return {
    innerHeight: window.innerHeight,
    vvOffsetTop: vv?.offsetTop ?? -1,
    vvHeight: vv?.height ?? -1,
    composerBottom: Math.round(composer.getBoundingClientRect().bottom),
    rootBottom: Math.round(root.getBoundingClientRect().bottom),
    pageScrollTop: document.scrollingElement?.scrollTop ?? -1,
    rootScrollTop: root.scrollTop,
    keyboardVar: getComputedStyle(document.documentElement)
      .getPropertyValue("--keyboard-height").trim() || "(none)",
    safeBottomVar: getComputedStyle(document.body)
      .getPropertyValue("--pi-safe-bottom").trim() || "(none)",
    composerMargin: getComputedStyle(composer).marginBottom,
  };
}

export function formatTelemetry(t: TelemetryReadout): string {
  return [
    `inner=${t.innerHeight}`,
    `vv=${Math.round(t.vvOffsetTop)}+${Math.round(t.vvHeight)}`,
    `root.bottom=${t.rootBottom}`,
    `composer.bottom=${t.composerBottom}`,
    `scroll=page:${t.pageScrollTop}/root:${t.rootScrollTop}`,
    `kbVar=${t.keyboardVar}`,
    `safe=${t.safeBottomVar}`,
    `margin=${t.composerMargin}`,
  ].join("\n");
}
