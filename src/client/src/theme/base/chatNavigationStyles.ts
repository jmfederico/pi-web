/** Base theme owns shared presentation; components retain behavior. */
import chatNavigationCss from "./chatNavigation.css?inline";
import { baseThemeStyles } from "./styles";

/** Navigation can render in the composer while ChatView retains scroll ownership. */
export const chatNavigationStyles = baseThemeStyles(chatNavigationCss);
