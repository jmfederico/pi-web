import { FormattedText } from "../../src/client/src/components/FormattedText";

const style = document.createElement("style");
style.textContent = `
  body { margin: 0; padding: 16px; font-family: system-ui; background: #fafafa; color: #222; }
  body.dark { background: #161616; color: #eee; }
  main { max-width: 680px; margin-inline: auto; }
`;
document.head.append(style);
const main = document.createElement("main");
const formatted = new FormattedText();
formatted.text = String.raw`Inline $E=mc^2$ and Chinese 中文\(x_1^2\)公式.

\[
\frac{a+b}{c+d} = \sqrt{x^2+y^2}
\]

$$${Array.from({ length: 35 }, (_, i) => `x_{${String(i)}}`).join(" + ")}$$
` + "\nLiteral code: `$notMath$` and prices $5 or $10.";
main.append(formatted);
document.body.append(main);
await formatted.updateComplete;
document.body.dataset["ready"] = "true";
