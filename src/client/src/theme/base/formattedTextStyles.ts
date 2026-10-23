/** Base theme owns shared presentation; components retain behavior. */
import formattedTextCss from "./formattedText.css?inline";
import { baseThemeStyles } from "./styles";

export const formattedTextStyles = baseThemeStyles(formattedTextCss);
