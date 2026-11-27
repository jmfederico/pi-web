import audioPlugin from "../../pi-web-plugins/audio/pi-web-plugin";
import filesPlugin from "../../pi-web-plugins/files/pi-web-plugin";
import { WorkspaceFileViewer } from "../../pi-web-plugins/files/FilesViewer";
import { createFilesContent } from "../../pi-web-plugins/files/filesLocalization";
import type { FileContentResponse, WorkspaceFilesCapabilityV1 } from "../../src/plugin-api";
import { LocalizationService } from "../../src/client/src/localization/service";
import { FileIconService, fileIconsCapabilityToken } from "../../src/client/src/fileIconService";
import { createPluginLocalization } from "../../src/client/src/plugins/localization";
import { adaptPublicPlugin } from "../../src/client/src/plugins/publicContext";
import { PluginRegistry } from "../../src/client/src/plugins/registry";
import type { PiWebPlugin as InternalPlugin } from "../../src/client/src/plugins/types";

const service = new LocalizationService();
const lifetime = new AbortController();
const registry = new PluginRegistry({
  localization: service,
  hostCapabilities: [{ capability: fileIconsCapabilityToken, value: new FileIconService().capability }],
});
const filesEntry: unknown = filesPlugin;
// The real loader validates opaque external callbacks; this fixture supplies a known public-v5 entry at that boundary.
// oxlint-disable-next-line typescript/consistent-type-assertions -- Public-v5 callbacks are adapted to internal services by PluginRegistry at runtime.
await registry.register({ id: "pi-web.files", plugin: adaptPublicPlugin(filesEntry as InternalPlugin) });
await registry.register({ id: "pi-web.audio", sourcePluginId: "pi-web.audio", backendRevision: "audio-fixture-r1", pairedResourceVersion: 1, plugin: adaptPublicPlugin(audioPlugin) });
const viewer = new WorkspaceFileViewer();
viewer.content = createFilesContent(createPluginLocalization(service, "files", "fixture-files", lifetime.signal));
viewer.machineId = "local";
viewer.projectId = "p";
viewer.workspaceId = "w";
viewer.filePreviewing = registry.filePreviewing;
viewer.modeStore = { adopt: () => undefined, publish: () => undefined };
viewer.previewUrlBuilder = (_project, _workspace, path, options) => {
  const url = new URL("fixture-files/preview", document.baseURI);
  url.search = new URLSearchParams({ path, ...(options?.modifiedAt === undefined ? {} : { v: options.modifiedAt }), ...(options?.download === true ? { download: "1" } : {}) }).toString();
  return url.toString();
};
const audioFile: FileContentResponse = { path: "sample.wav", encoding: "utf8", size: 64_044, modifiedAt: "fixture", content: "", truncated: false, binary: true };
const textFile: FileContentResponse = { ...audioFile, path: "notes.txt", content: "Original file source", size: 20, binary: false };
const unavailable = (): never => { throw new Error("Unused fixture file operation"); };
const files: WorkspaceFilesCapabilityV1 = {
  capabilityVersion: 1, defaultUploadFolder: "uploads", maxInlinePreviewBytes: 10 * 1024 * 1024,
  readFile: () => Promise.resolve(audioFile), listFiles: unavailable, writeFile: unavailable, deleteFile: unavailable, moveFile: unavailable, uploadFile: unavailable,
  previewUrl: (path, options) => viewer.previewUrlBuilder("p", "w", path, { ...(options?.version === undefined ? {} : { modifiedAt: options.version }) }),
  downloadUrl: (path) => viewer.previewUrlBuilder("p", "w", path, { download: true }),
};
viewer.files = files;
const show = (file: FileContentResponse): void => { viewer.selectedPath = file.path; viewer.file = file; };
const svgFile: FileContentResponse = { ...textFile, path: "diagram.svg", mediaType: "image", mimeType: "image/svg+xml", content: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="steelblue"/></svg>' };
const htmlFile: FileContentResponse = { ...textFile, path: "report.html", mediaType: "html", mimeType: "text/html", content: "<h1>Report</h1><script>parent.document.body.dataset.executed = true</script>" };
const markdownFile: FileContentResponse = { ...textFile, path: "notes.md", mediaType: "markdown", language: "markdown", content: "# Notes\n\n[Safe](https://example.test)\n\n<script>bad()</script>" };
const pdfFile: FileContentResponse = { ...audioFile, path: "report.pdf", mediaType: "pdf", mimeType: "application/pdf" };
for (const [label, file] of [["Audio file", audioFile], ["Text file", textFile], ["Image file", svgFile], ["HTML file", htmlFile], ["Markdown file", markdownFile], ["PDF file", pdfFile]] as const) {
  const button = document.createElement("button"); button.textContent = label;
  button.addEventListener("click", () => { show(file); }); document.body.append(button);
}
document.body.style.cssText = "margin:0; padding:8px; box-sizing:border-box; font-family:sans-serif;";
viewer.style.cssText = "display:flex; margin-top:8px; width:100%; min-width:0; height:500px;";
show(audioFile);
document.body.append(viewer);
window.addEventListener("pagehide", () => { lifetime.abort(); void registry.dispose(); }, { once: true });
await viewer.updateComplete;
document.body.dataset["ready"] = "true";
