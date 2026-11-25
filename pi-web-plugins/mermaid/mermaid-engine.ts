// Built as one IIFE, executed only inside an opaque-origin sandbox frame.
// One frame serves every diagram; Mermaid resets per-diagram configuration on each render.
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

// Width-dependent diagrams, such as Gantt charts, lay out against this stage.
const stage = document.createElement("div");
document.body.append(stage);

interface DrawRequest { readonly id: number; readonly text: string; readonly width: number }

function drawRequest(data: unknown): DrawRequest | undefined {
  if (typeof data !== "object" || data === null || !("type" in data) || data.type !== "mermaid-render") return undefined;
  if (!("id" in data) || typeof data.id !== "number" || !("text" in data) || typeof data.text !== "string"
    || !("width" in data) || typeof data.width !== "number" || !Number.isFinite(data.width)) return undefined;
  if (data.text.length > 100_000) return undefined;
  return { id: data.id, text: data.text, width: Math.min(4096, Math.max(160, data.width)) };
}

let queue = Promise.resolve();
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.source !== parent) return;
  const request = drawRequest(event.data);
  if (request !== undefined) queue = queue.then(() => draw(request));
});
parent.postMessage({ type: "mermaid-ready" }, "*");

function pixels(value: string | null): number | undefined {
  const match = /^\s*([\d.]+)\s*(px)?\s*$/u.exec(value ?? "");
  const number = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function viewBox(svg: SVGSVGElement): { width: number; height: number } | undefined {
  const [, , width = Number.NaN, height = Number.NaN] = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u).map(Number);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Give the SVG an explicit intrinsic size so an image reserves its layout before decoding. */
function intrinsicSize(svg: SVGSVGElement): { width: number; height: number } {
  const box = viewBox(svg);
  const declared = { width: pixels(svg.getAttribute("width")), height: pixels(svg.getAttribute("height")) };
  const width = pixels(svg.style.maxWidth) ?? declared.width ?? box?.width;
  const ratio = box !== undefined ? box.height / box.width
    : declared.width !== undefined && declared.height !== undefined ? declared.height / declared.width : undefined;
  if (width !== undefined && ratio !== undefined) return { width, height: width * ratio };
  stage.replaceChildren(svg);
  const rect = svg.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

async function draw({ id, text, width }: DrawRequest): Promise<void> {
  try {
    stage.style.width = `${String(width)}px`;
    const { svg } = await mermaid.render("diagram", text, stage);
    const clean = DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ["foreignObject", "a", "script", "image", "use"],
      RETURN_DOM_FRAGMENT: true,
    });
    const root = clean.firstElementChild;
    if (!(root instanceof SVGSVGElement)) throw new Error("Mermaid produced no SVG");
    const measured = intrinsicSize(root);
    // Whole pixels let the host image's attributes match the SVG's own size exactly.
    const size = { width: Math.round(measured.width), height: Math.round(measured.height) };
    if (!(size.width > 0 && size.height > 0)) throw new Error("Mermaid produced an empty SVG");
    root.setAttribute("width", String(size.width));
    root.setAttribute("height", String(size.height));
    root.style.removeProperty("max-width");
    // Images require standalone XML, not the HTML serialization of an inline SVG.
    const markup = new XMLSerializer().serializeToString(root);
    parent.postMessage({ type: "mermaid-rendered", id, svg: markup, width: size.width, height: size.height }, "*");
  } catch {
    parent.postMessage({ type: "mermaid-error", id }, "*");
  } finally {
    stage.replaceChildren();
  }
}
