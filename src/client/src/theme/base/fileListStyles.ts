/** Base theme owns shared presentation; components retain behavior. */
import uiFileListCss from "./uiFileList.css?inline";
import { baseThemeStyles } from "./styles";

/** Compact native file rows shared by independent Files and Git panels. */
export const uiFileListStyles = baseThemeStyles(uiFileListCss);
