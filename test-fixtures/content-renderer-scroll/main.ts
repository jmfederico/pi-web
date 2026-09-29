import { html } from "lit";
import { FilesCodeViewer } from "../../pi-web-plugins/files/FilesCodeViewer";
import { WorkspaceFileViewer } from "../../pi-web-plugins/files/FilesViewer";
import { MermaidPreview } from "../../pi-web-plugins/mermaid/MermaidPreview";
import { FormattedText } from "../../src/client/src/components/FormattedText";
import { createContentRenderingService } from "../../src/client/src/formatting/contentRendering";

customElements.define("scroll-files-viewer", WorkspaceFileViewer);
customElements.define("pi-web-files-code-viewer", FilesCodeViewer);
customElements.define("scroll-mermaid-preview", MermaidPreview);
const params = new URLSearchParams(location.search);
// Optional local demo, never modified by this harness. Default is deterministic
// and taller than both the preview viewport and Mermaid's iframe height cap.
const text = params.has("demo")
  ? await (await fetch("/dev-plugins/mermaid-complex-demo.mmd")).text()
  : `flowchart TD\n${Array.from({ length: 45 }, (_, i) => `N${i}[${i === 44 ? "DIAGRAM END" : `Step ${i}`}]${i === 0 ? "" : `\nN${i - 1} --> N${i}`}`).join("\n")}`;
const engine = () => fetch("/dist/pi-web-plugins/mermaid/browser/mermaid-engine.js").then((response) => {
  if (!response.ok) throw new Error("Build plugins before running this fixture");
  return response.text();
});
const service = createContentRenderingService(() => [{
  id: "mermaid:diagram", label: "Mermaid", renderer: {
    id: "diagram", render: (input) => html`<scroll-mermaid-preview .input=${input} .loadEngine=${engine}></scroll-mermaid-preview>`,
  },
}]);
const viewer = new WorkspaceFileViewer();
viewer.selectedPath = "tall.mmd";
viewer.file = { path: "tall.mmd", content: text, size: text.length, binary: false, truncated: false, language: "mermaid", encoding: "utf8", modifiedAt: "2026-01-01T00:00:00Z" };
viewer.contentRendering = service.capability;
viewer.modeStore = { adopt: () => undefined, publish: () => {} };
document.querySelector("#files")!.append(viewer);
const chat = new FormattedText();
chat.text = `Before diagram\n\n\`\`\`mermaid\n${text}\n\`\`\`\n\nAfter diagram`;
chat.contentRendering = service;
document.querySelector("#chat")!.append(chat);
