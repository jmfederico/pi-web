// Built as one IIFE, executed only inside an opaque-origin sandbox frame.
import mermaid from "mermaid";
import DOMPurify from "dompurify";

mermaid.initialize({
  startOnLoad: false,
  htmlLabels: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  maxTextSize: 100_000,
  maxEdges: 500,
  secure: ["secure", "securityLevel", "startOnLoad", "suppressErrorRendering", "maxTextSize", "maxEdges", "htmlLabels", "flowchart"],
});

let started = false;
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent || started) return;
  const data = event.data;
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "mermaid-render"
    || !("text" in data) || typeof data.text !== "string" || data.text.length > 100_000) return;
  started = true;
  void draw(data.text);
});
parent.postMessage({ type: "mermaid-ready" }, "*");

async function draw(text: string): Promise<void> {
  try {
    const { svg } = await mermaid.render("diagram", text);
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "a", "script", "image", "use"],
    });
    document.body.innerHTML = clean;
    parent.postMessage({ type: "mermaid-rendered", height: document.body.scrollHeight }, "*");
  } catch {
    document.body.replaceChildren();
    parent.postMessage({ type: "mermaid-error" }, "*");
  }
}
