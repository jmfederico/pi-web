import { SessionCleanupDialog } from "../../src/client/src/components/SessionCleanupDialog";
import type { SessionCleanupPreviewResponse } from "../../src/client/src/api";
import { pluginStyles } from "../../src/client/src/plugins/styles";

const style = document.createElement("style");
style.textContent = `
  :root { --pi-bg: #161616; --pi-surface: #252525; --pi-text: #eee; --pi-border: #555; --pi-border-muted: #444; --pi-muted: #aaa; --pi-overlay: #0008; --pi-accent: #aaf; --pi-danger: #f88; --pi-warning-border: #c95; --pi-warning-surface: #432; }
  body { margin: 0; background: var(--pi-bg); color: var(--pi-text); font-family: system-ui; }
`;
document.head.append(style);
pluginStyles.registerRoot(document);

const preview: SessionCleanupPreviewResponse = {
  generatedAt: "2026-10-21T12:00:00Z",
  thresholds: { archiveIdleDays: 30 },
  projects: Array.from({ length: 8 }, (_, index) => ({ cwd: `/projects/long-workspace-path/feature-branch-${String(index)}/session-cleanup`, archiveCount: index + 1, deleteCount: 0 })),
  totals: { archiveCount: 36, deleteCount: 0 },
  skippedPinnedSessionIds: ["pinned"],
};
const view = new SessionCleanupDialog();
view.onPreview = (request) => { view.previewRequest = request; view.preview = { ...preview }; };
view.onClose = () => { view.remove(); };
document.body.append(view);
await view.updateComplete;
document.body.dataset["ready"] = "true";
