export interface ChatRenderItem {
  /** Position and presentation slice within the current transcript. */
  slot: string;
  /** Authoritative identity, once the message has been committed. */
  identity?: string;
  /** Group members let prepends/growth retain the owner even when an edge changes. */
  identities?: readonly string[];
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
    const identities = new Map<string, string[]>();
    for (const item of this.previous) {
      for (const identity of item.identities ?? (item.identity === undefined ? [] : [item.identity])) {
        const owners = identities.get(identity) ?? [];
        owners.push(item.key);
        identities.set(identity, owners);
      }
    }
    const provisional = new Map(this.previous.filter((item) => item.identity === undefined).map((item) => [item.slot, item.key]));
    const used = new Set<string>();
    this.previous = items.map((item) => {
      const candidates = item.identities ?? (item.identity === undefined ? [] : [item.identity]);
      const inherited = candidates.flatMap((identity) => identities.get(identity) ?? []).find((key) => !used.has(key));
      const fallback = provisional.get(item.slot);
      const key = inherited ?? (fallback !== undefined && !used.has(fallback) ? fallback : `render:${String(this.sequence++)}`);
      used.add(key);
      return { ...item, key };
    });
    // Reconcile only the current render, not every message ever visited.
    return this.previous.map((item) => item.key);
  }
}
