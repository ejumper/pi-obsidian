/**
 * Obsidian ribbon items (0.5.13) — enumerate the workspace ribbon's action
 * icons and invoke one by label. The ribbon has no public registry: items are
 * plain DOM (`.side-dock-ribbon-action` elements carrying their own click
 * handlers), so the aria-label is the only stable identity a setting can
 * store, and invoking = clicking the element.
 */

export interface RibbonItem {
  label: string;
  el: HTMLElement;
}

export function listRibbonItems(): RibbonItem[] {
  const out: RibbonItem[] = [];
  document
    .querySelectorAll<HTMLElement>(".side-dock-ribbon-action")
    .forEach((el, i) => {
      const label = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").trim();
      out.push({ label: label || `(unnamed ${i + 1})`, el });
    });
  return out;
}

/** Click the ribbon item whose label matches exactly; false when it's gone. */
export function invokeRibbonItem(label: string): boolean {
  const item = listRibbonItems().find((it) => it.label === label);
  if (!item) return false;
  item.el.click();
  return true;
}
