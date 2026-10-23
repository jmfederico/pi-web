/** Base theme owns shared presentation; components retain behavior. */
import { css } from "lit";
import uiDialogCss from "./uiDialog.css?inline";
import uiSelectionCss from "./uiSelection.css?inline";
import { baseThemeStyles } from "./styles";
import { uiButtonStyles } from "./controlStyles";

/** Content chrome for ModalSurface; focus trapping and dismissal stay with that component. */
export const uiDialogStyles = css`${uiButtonStyles}${baseThemeStyles(uiDialogCss)}`;

/** Gapless choices, including rows with a separate pin or checkbox action. */
export const uiSelectionStyles = baseThemeStyles(uiSelectionCss);

// Preserve existing dialog consumers while allowing forms outside modals.
export { uiFormStyles } from "./formStyles";
