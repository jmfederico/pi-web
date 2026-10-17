/** Base theme owns shared presentation; components retain behavior. */
import uiFormCss from "./uiForm.css?inline";
import { baseThemeStyles } from "./styles";

/** Native fields and form structure, independent of modal or transcript placement. */
export const uiFormStyles = baseThemeStyles(uiFormCss);
