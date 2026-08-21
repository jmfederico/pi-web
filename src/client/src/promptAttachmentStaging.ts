import type { CapturedAttachment } from "./promptAttachmentCapture";

/** A captured attachment staged in the composer, tagged with a stable id for chip removal/rendering. */
export type PendingAttachment = CapturedAttachment & { id: string };

export type StagedAttachmentStore = Map<string, readonly PendingAttachment[]>;

/**
 * In-memory (not localStorage) staging area for attachments pending send, keyed
 * the same way as `promptDraftStorage` (by `machineId:sessionId`). Attachment
 * payloads are base64 file/image data, which can be large, so unlike the draft
 * text they are not persisted across reloads.
 *
 * This mirrors `promptDraftStorage`/`cachedNewSessions` deliberately, both in
 * shape (an injectable store defaulting to a shared instance, the way those
 * modules default `storage` to `browserStorage()`) and in why it exists:
 * `PromptEditor` is a single long-lived element that just gets pointed at a
 * different session, and `sessionController` reassigns session ids under the
 * user in a few places (new-session provisioning, cached-session
 * replacement) where it already moves the draft via `moveDraft`. Staged
 * attachments need the same treatment so they migrate rather than vanish
 * when a session's id changes for reasons other than the user switching tabs.
 */
function defaultStore(): StagedAttachmentStore {
  return sharedStore;
}

const sharedStore: StagedAttachmentStore = new Map();

export function loadStagedAttachments(key: string, store: StagedAttachmentStore = defaultStore()): readonly PendingAttachment[] {
  return store.get(key) ?? [];
}

export function saveStagedAttachments(key: string, attachments: readonly PendingAttachment[], store: StagedAttachmentStore = defaultStore()): void {
  if (attachments.length > 0) store.set(key, attachments);
  else store.delete(key);
}

export function clearStagedAttachments(key: string, store: StagedAttachmentStore = defaultStore()): void {
  store.delete(key);
}

export function moveStagedAttachments(fromKey: string, toKey: string, store: StagedAttachmentStore = defaultStore()): void {
  const attachments = store.get(fromKey);
  if (attachments === undefined) return;
  store.set(toKey, attachments);
  store.delete(fromKey);
}
