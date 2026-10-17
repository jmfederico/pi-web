/** Base theme owns shared presentation; components retain behavior. */
import sidebarListCss from "./sidebarList.css?inline";
import { baseThemeStyles } from "./styles";

/** Sidebar rows own their spacing so the space between labels remains clickable. */
export const sidebarListStyles = baseThemeStyles(sidebarListCss);
