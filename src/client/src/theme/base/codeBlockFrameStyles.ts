/** Base theme owns shared presentation; components retain behavior. */
import { css } from "lit";
import codeBlockFrameCss from "./codeBlockFrame.css?inline";
import { baseThemeStyles } from "./styles";
import { uiButtonStyles } from "./controlStyles";

/** Shared presentation only: source and preview lifecycle stay with their owners. */
export const codeBlockFrameStyles = css`${uiButtonStyles}${baseThemeStyles(codeBlockFrameCss)}`;
