import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER,
  effectiveWorkspaceAttachmentsFolder,
  workspaceEffectiveAttachmentsFolder,
} from "./workspaceAttachments";

describe("workspace attachments folder helpers", () => {
  it("falls back to the built-in default when nothing is configured", () => {
    expect(DEFAULT_WORKSPACE_ATTACHMENTS_FOLDER).toBe(".pi-web/attachments");
    expect(effectiveWorkspaceAttachmentsFolder(undefined)).toBe(".pi-web/attachments");
    expect(effectiveWorkspaceAttachmentsFolder({})).toBe(".pi-web/attachments");
    expect(effectiveWorkspaceAttachmentsFolder({ attachments: {} })).toBe(".pi-web/attachments");
  });

  it("resolves configured global and workspace-effective folders", () => {
    expect(effectiveWorkspaceAttachmentsFolder({ attachments: { defaultFolder: "saved/attachments" } })).toBe("saved/attachments");
    expect(workspaceEffectiveAttachmentsFolder({ attachments: { defaultFolder: "project/attachments" } }, "global/attachments")).toBe("project/attachments");
    expect(workspaceEffectiveAttachmentsFolder({}, "global/attachments")).toBe("global/attachments");
    expect(workspaceEffectiveAttachmentsFolder(undefined, "global/attachments")).toBe("global/attachments");
  });
});
