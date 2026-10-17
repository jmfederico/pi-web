/** Base theme owns shared presentation; components retain behavior. */
import uiNoticeCss from "./uiNotice.css?inline";
import { baseThemeStyles } from "./styles";

/** Status feedback independent of settings layout and modal placement. */
export const uiNoticeStyles = baseThemeStyles(uiNoticeCss);
