/** Base theme owns shared presentation; components retain behavior. */
import uiTranscriptCardCss from "./uiTranscriptCard.css?inline";
import { baseThemeStyles } from "./styles";

/** Form/record header chrome; consumers retain heading typography and disclosure state. */
export const uiTranscriptCardStyles = baseThemeStyles(uiTranscriptCardCss);
