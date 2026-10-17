/** Base theme owns shared presentation; components retain behavior. */
import sessionNotificationTrayCss from "./sessionNotificationTray.css?inline";
import { baseThemeStyles } from "./styles";

export const sessionNotificationTrayStyles = baseThemeStyles(sessionNotificationTrayCss);
