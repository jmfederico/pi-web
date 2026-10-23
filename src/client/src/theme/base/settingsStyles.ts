/** Base theme owns shared presentation; components retain behavior. */
import uiSettingsCss from "./uiSettings.css?inline";
import { baseThemeStyles } from "./styles";

/** Flat configuration groups; controls and persistence stay with the consumer. */
export const uiSettingsStyles = baseThemeStyles(uiSettingsCss);
