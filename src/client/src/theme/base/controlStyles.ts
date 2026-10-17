/** Base theme owns shared presentation; components retain behavior. */
import uiButtonCss from "./uiButton.css?inline";
import uiToolbarCss from "./uiToolbar.css?inline";
import uiTabCss from "./uiTab.css?inline";
import uiMenuCss from "./uiMenu.css?inline";
import { baseThemeStyles } from "./styles";

/**
 * Native controls keep their own events, focus, disabled state, and form semantics.
 * Public button/select/toolbar/tab patterns also serve host UI styles v1:
 * preserve the contract documented in docs/plugins.md#host-provided-ui-styles.
 */
export const uiButtonStyles = baseThemeStyles(uiButtonCss);

/** A compact secondary control group; spacing belongs to its controls, not gaps. */
export const uiToolbarStyles = baseThemeStyles(uiToolbarCss);

/** Tab appearance only; native buttons and their owner's navigation retain interaction semantics. */
export const uiTabStyles = baseThemeStyles(uiTabCss);

/** A popup surface, not an ARIA menu: keyboard behavior remains with its owner. */
export const uiMenuStyles = baseThemeStyles(uiMenuCss);
