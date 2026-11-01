import { css, unsafeCSS } from "lit";
// Browsers resolve font faces at document scope, not inside a shadow root.
// Both imports are bundled locally by Vite, including deployment-relative fonts.
import "katex/dist/katex.min.css";
import katexCss from "katex/dist/katex.min.css?inline";

export const markdownMathStyles = css`
  ${unsafeCSS(katexCss)}
  .katex { direction: ltr; unicode-bidi: isolate; overflow-wrap: normal; }
  .katex-display { max-width: 100%; overflow-x: auto; overflow-y: hidden; padding-block: 2px; }
`;
