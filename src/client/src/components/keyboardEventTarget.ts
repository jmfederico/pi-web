/**
 * Whether a composed keyboard event originated from a native control with its
 * own Enter activation, including one inside an open shadow root. List-level
 * shortcuts must defer so buttons click and links navigate normally.
 */
export function keyboardEventOriginatesFromNativeActivationControl(event: KeyboardEvent): boolean {
  return event.composedPath().some((target) => target instanceof HTMLButtonElement
    || (target instanceof HTMLAnchorElement && target.hasAttribute("href")));
}
