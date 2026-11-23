/** Base theme owns shared presentation; components retain behavior. */
import { css } from "lit";
import { listReorderStyles } from "./listReorderStyles";
import sidebarListCss from "./sidebarList.css?inline";
import { baseThemeStyles } from "./styles";

/** Sidebar rows own their spacing so the space between labels remains clickable. */
export const sidebarListStyles = css`${listReorderStyles}${baseThemeStyles(sidebarListCss)}`;
