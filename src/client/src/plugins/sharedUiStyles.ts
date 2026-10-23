import { css } from "lit";
import { uiButtonStyles, uiTabStyles, uiToolbarStyles } from "../theme/base/controlStyles";
import { uiFileListStyles } from "../theme/base/fileListStyles";

// One experimental shared bundle; intentionally excludes shell/chat layout and
// component-specific :host rules. CSSResult compiles its sheet only when requested.
export const sharedUiStyles = css`${uiButtonStyles}${uiToolbarStyles}${uiTabStyles}${uiFileListStyles}`;
