const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const MATH_NAMESPACE = "http://www.w3.org/1998/Math/MathML";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SVG_ELEMENTS = new Set(["svg", "g", "path", "line", "rect", "circle", "ellipse", "polyline", "polygon", "title", "desc"]);
const SVG_DIMENSIONS = new Set(["width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "stroke-width"]);
const SVG_NUMBERS = /^[\d.eE\s,+-]+$/u;
const SVG_PATH = /^[MmZzLlHhVvCcSsQqTtAa\d.eE\s,+-]+$/u;
const HTML_ELEMENTS = new Set([
  "span", "div", "p", "br", "wbr", "b", "strong", "i", "em", "s", "small",
  "sub", "sup", "code", "kbd", "samp", "var", "mark", "u",
]);
const MATH_ELEMENTS = new Set([
  "math", "mrow", "mi", "mn", "mo", "mtext", "mspace", "ms", "mfrac", "msqrt",
  "mroot", "mstyle", "merror", "mpadded", "mphantom", "mfenced", "menclose",
  "msub", "msup", "msubsup", "munder", "mover", "munderover", "mmultiscripts",
  "mprescripts", "none", "mtable", "mtr", "mtd", "semantics", "annotation",
]);
const RESERVED_CLASSES = new Set(["plain-code-block", "code-block-wrapper"]);
const DIMENSION_PROPERTIES = new Set([
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "top", "right", "bottom", "left", "vertical-align", "font-size", "line-height",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-width", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
]);
const COLOR_PROPERTIES = new Set(["color", "background-color", "border-color"]);
const DIMENSION = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:em|ex|rem|px|pt|pc|cm|mm|in|%)?$/iu;
const COLOR = /^(?:[a-z]+|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d.,%\s/+-]+\))$/iu;
const MATH_DIMENSIONS = new Set(["width", "height", "depth", "lspace", "rspace", "voffset", "linethickness", "mathsize", "columnspacing", "rowspacing"]);
const MATH_ENUMS: Readonly<Record<string, readonly string[]>> = {
  display: ["block", "inline"],
  displaystyle: ["true", "false"],
  stretchy: ["true", "false"],
  symmetric: ["true", "false"],
  fence: ["true", "false"],
  separator: ["true", "false"],
  accent: ["true", "false"],
  accentunder: ["true", "false"],
  movablelimits: ["true", "false"],
  mathvariant: ["normal", "bold", "italic", "bold-italic", "double-struck", "bold-fraktur", "script", "bold-script", "fraktur", "sans-serif", "bold-sans-serif", "sans-serif-italic", "sans-serif-bold-italic", "monospace"],
  columnalign: ["left", "center", "right"],
  rowalign: ["top", "bottom", "center", "baseline", "axis"],
};

function dimensions(value: string): boolean {
  const parts = value.trim().split(/\s+/u);
  return parts.length <= 4 && parts.every((part) => DIMENSION.test(part));
}

function presentationStyle(value: string): string {
  // Parse only this deliberately small grammar, not arbitrary CSS. In particular,
  // URLs, var(), escaped identifiers, !important and resource-bearing properties
  // cannot enter the result. KaTeX's positioning comes from its host-loaded CSS.
  return value.split(";").flatMap((declaration) => {
    const colon = declaration.indexOf(":");
    if (colon < 0) return [];
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const content = declaration.slice(colon + 1).trim();
    if ((DIMENSION_PROPERTIES.has(name) && dimensions(content)) || (COLOR_PROPERTIES.has(name) && COLOR.test(content))) {
      return [`${name}: ${content}`];
    }
    return [];
  }).join("; ");
}

function copyPresentationAttributes(source: Element, target: Element): void {
  for (const attribute of source.attributes) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (name === "class") {
      const classes = value.split(/\s+/u).filter((part) => /^[a-z_][\w-]*$/iu.test(part) && !RESERVED_CLASSES.has(part));
      if (classes.length > 0) target.setAttribute("class", classes.join(" "));
    } else if (name === "style") {
      const style = presentationStyle(value);
      if (style !== "") target.setAttribute("style", style);
    } else if (name === "title" || name === "aria-label" || (name === "aria-hidden" && /^(?:true|false)$/u.test(value))) {
      target.setAttribute(name, value);
    } else if (name === "role" && /^(?:math|presentation|none)$/u.test(value)) {
      target.setAttribute(name, value);
    } else if (target.namespaceURI === SVG_NAMESPACE) {
      if ((SVG_DIMENSIONS.has(name) && DIMENSION.test(value))
        || ((name === "fill" || name === "stroke") && COLOR.test(value))
        || (name === "d" && SVG_PATH.test(value))
        || (name === "points" && SVG_NUMBERS.test(value))
        || (name === "fill-rule" && /^(?:nonzero|evenodd)$/u.test(value))
        || (name === "stroke-linecap" && /^(?:butt|round|square)$/u.test(value))
        || (name === "stroke-linejoin" && /^(?:miter|round|bevel)$/u.test(value))) {
        target.setAttribute(name, value);
      } else if (name === "viewbox" && SVG_NUMBERS.test(value) && value.trim().split(/[\s,]+/u).length === 4) {
        target.setAttribute("viewBox", value);
      } else if (name === "preserveaspectratio" && /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?: (?:meet|slice))?)$/u.test(value)) {
        target.setAttribute("preserveAspectRatio", value);
      }
    } else if (target.namespaceURI === MATH_NAMESPACE) {
      if ((MATH_DIMENSIONS.has(name) && dimensions(value))
        || (Object.hasOwn(MATH_ENUMS, name) && MATH_ENUMS[name]?.includes(value) === true)
        || (name === "scriptlevel" && /^[+-]?\d{1,2}$/u.test(value))
        || ((name === "mathcolor" || name === "mathbackground") && COLOR.test(value))
        || (name === "encoding" && target.localName === "annotation" && value === "application/x-tex")) {
        target.setAttribute(name, value);
      }
    }
  }
}

/**
 * Host-owned, inert extension presentation policy, separate from document HTML.
 * Rebuilds an allowlist of HTML/MathML and inert SVG geometry (for math glyphs).
 * Never admits links, images, SVG references/foreignObject/animation, custom
 * elements, handlers, resources, pre, or fence-reserved classes.
 * Styles accept only numeric dimensions and literal colors, not arbitrary CSS.
 * This constrains returned markup, not the JavaScript of an installed plugin.
 */
export function sanitizeMarkdownExtensionHtml(html: string): string {
  const source = document.createElement("template");
  source.innerHTML = html;
  const output = document.createElement("template");
  const pending: { source: Node; target: Node }[] = [{ source: source.content, target: output.content }];
  // Iterative traversal avoids a plugin-supplied nesting depth exhausting the stack.
  while (pending.length > 0) {
    const pair = pending.pop();
    if (pair === undefined) break;
    for (const child of pair.source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        pair.target.appendChild(document.createTextNode(child.textContent ?? ""));
      } else if (child instanceof Element) {
        const element = child;
        const allowed = element.namespaceURI === HTML_NAMESPACE
          ? HTML_ELEMENTS.has(element.localName)
          : element.namespaceURI === MATH_NAMESPACE
            ? MATH_ELEMENTS.has(element.localName)
            : element.namespaceURI === SVG_NAMESPACE && SVG_ELEMENTS.has(element.localName);
        if (!allowed) continue;
        const clean = document.createElementNS(element.namespaceURI, element.localName);
        copyPresentationAttributes(element, clean);
        pair.target.appendChild(clean);
        pending.push({ source: element, target: clean });
      }
    }
  }
  return output.innerHTML;
}
