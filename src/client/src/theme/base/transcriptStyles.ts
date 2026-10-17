/** Base theme owns shared presentation; components retain behavior. */
import uiTranscriptCss from "./uiTranscript.css?inline";
import { baseThemeStyles } from "./styles";

/** Flat transcript sections; consumers own layout and choose an opaque sticky-header tone. */
export const uiTranscriptStyles = baseThemeStyles(uiTranscriptCss);
