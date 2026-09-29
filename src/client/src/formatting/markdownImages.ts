import { workspaceFilePreviewUrl } from "../api/urls";
import type { MarkdownWorkspaceContext } from "./workspaceLinks";
import "../components/MarkdownImage";

/** Local Markdown destinations are filesystem references, not website routes. */
export function localMarkdownImage(reference: string, root: string): { path: string; outside: boolean } | undefined {
  if (reference === "" || /^[#?]/u.test(reference) || reference.startsWith("//") || /^[a-z][a-z\d+.-]*:/iu.test(reference)) return undefined;
  let path: string;
  try { path = decodeURIComponent(reference.split(/[?#]/u, 1)[0] ?? ""); } catch { return undefined; }
  // eslint-disable-next-line no-control-regex -- Filesystem references cannot contain control characters.
  if (path === "" || /[\\\u0000-\u001f\u007f]/u.test(path)) return undefined;
  if (path.startsWith("~/")) return { path, outside: true };
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${root}/${path}`).split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  const absolute = `/${segments.join("/")}`;
  const prefix = `${root.replace(/\/+$/u, "")}/`;
  return absolute.startsWith(prefix)
    ? { path: absolute.slice(prefix.length), outside: false }
    : { path: absolute, outside: true };
}

export function replaceLocalMarkdownImages(root: DocumentFragment, workspace: MarkdownWorkspaceContext, identity?: string): void {
  root.querySelectorAll("img[src]").forEach((image, index) => {
    const local = localMarkdownImage(image.getAttribute("src") ?? "", workspace.root);
    if (local === undefined) return;
    const preview = document.createElement("pi-web-markdown-image");
    preview.setAttribute("path", local.path);
    preview.setAttribute("description", image.getAttribute("alt") ?? "");
    if (identity !== undefined) preview.setAttribute("intent-key", JSON.stringify([identity, index]));
    preview.setAttribute("preview-url", workspaceFilePreviewUrl(workspace.projectId, workspace.workspaceId, local.path, {
      machineId: workspace.machineId, showImage: local.outside,
    }));
    if (local.outside) preview.setAttribute("outside", "");
    image.replaceWith(preview);
  });
}
