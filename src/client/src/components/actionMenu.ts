import type { ReactiveControllerHost } from "lit";
import { AnchoredPopupController } from "./anchoredPopup";

/** Row lookup and state stay with the list; the popup owns presentation. */
export function createActionMenuController(
  host: ReactiveControllerHost & { renderRoot: HTMLElement | DocumentFragment },
  getTarget: () => HTMLElement | undefined,
  onClose: () => void,
): AnchoredPopupController {
  return new AnchoredPopupController(host, () => {
    const anchor = getTarget();
    const panel = host.renderRoot.querySelector<HTMLElement>(".action-menu-panel");
    return anchor && panel ? { anchor, panel, onClose, options: { minWidth: 120 } } : undefined;
  });
}
