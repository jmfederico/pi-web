import { LitElement } from "lit";
import { composedFocusableElements } from "../focusableElements";
import { activeModalElement, composedContains, focusElement } from "../modalLayerRegistry";

/** Reveal a named Settings destination across panel shadow roots after rendering. */
export async function revealSettingsTarget(root: ParentNode, name: string, isCurrent: () => boolean): Promise<boolean> {
  const target = await findSettingsTarget(root, name);
  if (target === undefined || !target.isConnected || !isCurrent()) return false;
  const modal = activeModalElement(target.ownerDocument);
  if (modal !== undefined && !composedContains(modal, target)) return false;
  // A subsection can nominate its first available control, or receive focus
  // itself (tabindex=-1) when its controls are locked by policy.
  const control = composedFocusableElements(target)[0] ?? target;
  if (!focusElement(control)) return false;
  target.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
  return true;
}

async function findSettingsTarget(root: ParentNode, name: string): Promise<HTMLElement | undefined> {
  for (const element of root.children) {
    if (element instanceof LitElement) await element.updateComplete;
    if (element instanceof HTMLElement && element.getAttribute("data-settings-target") === name) return element;
    if (element.shadowRoot !== null) {
      const target = await findSettingsTarget(element.shadowRoot, name);
      if (target !== undefined) return target;
    }
    const target = await findSettingsTarget(element, name);
    if (target !== undefined) return target;
  }
  return undefined;
}
