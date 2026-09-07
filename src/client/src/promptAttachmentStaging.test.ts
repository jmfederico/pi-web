import { describe, expect, it } from "vitest";
import { clearStagedAttachments, loadStagedAttachments, moveStagedAttachments, saveStagedAttachments, type PendingAttachment, type StagedAttachmentStore } from "./promptAttachmentStaging";

const attachment: PendingAttachment = { id: "attachment-1", kind: "file", name: "notes.txt", mimeType: "text/plain", data: "aGVsbG8=", size: 5 };

describe("promptAttachmentStaging", () => {
  it("returns an empty list for a key with nothing staged", () => {
    const store: StagedAttachmentStore = new Map();
    expect(loadStagedAttachments("local:session-a", store)).toEqual([]);
  });

  it("saves and loads attachments staged for a key", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:session-a", [attachment], store);
    expect(loadStagedAttachments("local:session-a", store)).toEqual([attachment]);
  });

  it("drops the key once it is saved with no attachments left", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:session-a", [attachment], store);
    saveStagedAttachments("local:session-a", [], store);
    expect(store.has("local:session-a")).toBe(false);
  });

  it("clears a key outright", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:session-a", [attachment], store);
    clearStagedAttachments("local:session-a", store);
    expect(loadStagedAttachments("local:session-a", store)).toEqual([]);
  });

  it("moves staged attachments from one key to another, leaving the source empty", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:temp-1", [attachment], store);
    moveStagedAttachments("local:temp-1", "local:session-a", store);
    expect(loadStagedAttachments("local:temp-1", store)).toEqual([]);
    expect(loadStagedAttachments("local:session-a", store)).toEqual([attachment]);
  });

  it("does nothing when moving from a key with nothing staged", () => {
    const store: StagedAttachmentStore = new Map();
    saveStagedAttachments("local:session-a", [attachment], store);
    moveStagedAttachments("local:temp-1", "local:session-a", store);
    expect(loadStagedAttachments("local:session-a", store)).toEqual([attachment]);
  });
});
