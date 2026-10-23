export interface ChatRenderItem {
  /** Position and presentation slice within the current transcript. */
  slot: string;
  /** Authoritative identity, once the message has been committed. */
  identity?: string;
}

interface RenderKey extends ChatRenderItem {
  key: string;
}

/** Retain DOM ownership when a provisional message gains its durable identity. */
export class ChatRenderKeys {
  private transcript: string | undefined;
  private previous: RenderKey[] = [];
  private sequence = 0;

  reconcile(transcript: string, items: ChatRenderItem[]): string[] {
    if (this.transcript !== transcript) {
      this.transcript = transcript;
      this.previous = [];
      this.sequence = 0;
    }
    const identities = new Map(this.previous.filter((item) => item.identity !== undefined).map((item) => [item.identity, item.key]));
    const provisional = new Map(this.previous.filter((item) => item.identity === undefined).map((item) => [item.slot, item.key]));
    this.previous = items.map((item) => ({
      ...item,
      key: (item.identity === undefined ? undefined : identities.get(item.identity))
        ?? provisional.get(item.slot)
        ?? `render:${String(this.sequence++)}`,
    }));
    // Retain only the rendered window, not every message ever visited.
    return this.previous.map((item) => item.key);
  }
}
