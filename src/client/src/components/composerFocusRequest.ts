/** What the host has committed when a render completes. */
export interface ComposerFocusSurface {
  /** Machine/session key of the selected chat, if any. */
  readonly selectedChatKey: string | undefined;
  readonly chatVisible: boolean;
  readonly modalOpen: boolean;
  /** Move focus to the chat's input owner; return false while it is not rendered yet. */
  focus(): boolean;
}

/**
 * Holds one request to focus a chat's composer until that composer exists.
 *
 * The host offers each committed render. The request is fulfilled once the
 * target's input owner is rendered, and dropped when it can no longer apply:
 * stale navigation, another chat, hidden Chat, or a modal owning focus.
 */
export class ComposerFocusRequest {
  private pending: { readonly targetChatKey: string; readonly isCurrent: () => boolean } | undefined;

  /** Replace any earlier request. */
  request(targetChatKey: string, isCurrent: () => boolean): void {
    this.pending = { targetChatKey, isCurrent };
  }

  /** Offer a committed render. Reads the surface only while a request is pending. */
  offer(readSurface: () => ComposerFocusSurface): void {
    const pending = this.pending;
    if (pending === undefined) return;
    const surface = readSurface();
    const applicable = pending.isCurrent()
      && surface.selectedChatKey === pending.targetChatKey
      && surface.chatVisible
      && !surface.modalOpen;
    if (applicable && !surface.focus()) return;
    this.pending = undefined;
  }
}
