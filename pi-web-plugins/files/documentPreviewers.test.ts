import type { FileContentResponse } from "@jmfederico/pi-web/plugin-api";
import { html } from "lit";
import { describe, expect, it } from "vitest";
import { createDocumentPreviewers } from "./documentPreviewers";
import { filesLocalizationFixture } from "./filesLocalization.testSupport";

const file: FileContentResponse = { path: "misleading.txt", content: "", encoding: "utf8", binary: false, size: 20, modifiedAt: "revision", truncated: false };

describe("document preview contributions", () => {
  it("uses authoritative media classification and preserves safe defaults", () => {
    const previewers = createDocumentPreviewers({ html, content: filesLocalizationFixture().content, getMarkdownRendering: () => undefined, getStylesheetIntegration: () => undefined });
    for (const [mediaType, binary, id, mode] of [
      ["image", true, "image", "automatic"], ["image", false, "svg", "manual"],
      ["pdf", true, "pdf", "automatic"], ["html", false, "html", "manual"], ["markdown", false, "markdown", "manual"],
    ] as const) {
      const matches = previewers.filter((previewer) => previewer.supports?.({ machineId: "local", projectId: "p", workspaceId: "w", file: { ...file, mediaType, binary } }) === true);
      expect(matches.map(({ id, title, renderMode }) => ({ id, title, renderMode }))).toEqual([{ id, title: "Preview", renderMode: mode }]);
    }
    expect(previewers.every(({ fileExtensions, mimeTypes }) => fileExtensions === undefined && mimeTypes === undefined)).toBe(true);
    expect(previewers.filter((previewer) => previewer.supports?.({ machineId: "local", projectId: "p", workspaceId: "w", file: { ...file, path: "fake.html", mimeType: "text/html" } }) === true)).toEqual([]);
  });

  it("keeps contribution titles localized", async () => {
    const { content, service } = filesLocalizationFixture();
    const previewer = createDocumentPreviewers({ html, content, getMarkdownRendering: () => undefined, getStylesheetIntegration: () => undefined })[0];
    if (previewer === undefined) throw new Error("Missing previewer");
    service.registerCatalog({ id: "files-test", namespace: "plugin:files:files", locale: "fr", load: () => Promise.resolve({ preview: "Aperçu" }) });
    await service.setPreferences({ ...service.preferences, language: "fr" });
    expect(previewer.title).toBe("Aperçu");
  });
});
