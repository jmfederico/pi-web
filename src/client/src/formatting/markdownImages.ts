import { workspaceFilePreviewUrl } from "../api/urls";
import type { MarkdownWorkspaceContext } from "./workspaceLinks";
import "../components/MarkdownImage";

/** Local Markdown destinations are filesystem references, not website routes. */
export function localMarkdownImage(reference: string, root: string): { path: string; outside: boolean } | undefined {
  const windowsWorkspace = /^(?:[a-z]:[\\/]|\\\\|\/\/)/iu.test(root);
  const workspaceRoot = windowsWorkspace ? root.replaceAll("\\", "/") : root;
  const driveReference = windowsWorkspace && /^[a-z]:\//iu.test(reference);
  if (reference === "" || /^[#?]/u.test(reference) || reference.startsWith("//")
    || (/^[a-z][a-z\d+.-]*:/iu.test(reference) && !driveReference)) return undefined;
  let path: string;
  try { path = decodeURIComponent(reference.split(/[?#]/u, 1)[0] ?? ""); } catch { return undefined; }
  // oxlint-disable-next-line no-control-regex -- Filesystem references cannot contain control characters.
  if (path === "" || /[\\\u0000-\u001f\u007f]/u.test(path)) return undefined;
  if (path.startsWith("~/")) return { path, outside: true };
  // Keep Windows drive/share anchors outside traversal normalization, using
  // the workspace's path syntax rather than the browser's operating system.
  const rootAnchor = windowsWorkspace ? /^(?:[a-z]:|\/\/[^/]+\/[^/]+)/iu.exec(workspaceRoot)?.[0] ?? "" : "";
  const pathDrive = windowsWorkspace ? /^[a-z]:\//iu.exec(path)?.[0].slice(0, 2) : undefined;
  const target = pathDrive !== undefined ? path.slice(2)
    : path.startsWith("/") ? path : `${workspaceRoot.slice(rootAnchor.length)}/${path}`;
  const segments: string[] = [];
  for (const segment of target.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }
  const absolute = `${pathDrive ?? rootAnchor}/${segments.join("/")}`;
  const prefix = `${workspaceRoot.replace(/\/+$/u, "")}/`;
  const inside = windowsWorkspace ? absolute.toLowerCase().startsWith(prefix.toLowerCase()) : absolute.startsWith(prefix);
  return inside
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
