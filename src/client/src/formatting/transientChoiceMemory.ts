// Ephemeral choices made in this tab, not durable user settings. Revisit within
// 15 minutes restores a choice; reads do not extend its lifetime.
export class TransientChoiceMemory<Value> {
  private readonly entries = new Map<string, { source: string; value: Value; chosenAt: number }>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly limit = 128, private readonly ttl = 15 * 60_000) {}

  read(key: string, source: string): Value | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.source !== source || this.now() - entry.chosenAt >= this.ttl) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  choose(key: string, source: string, value: Value): void {
    this.entries.delete(key);
    this.entries.set(key, { source, value, chosenAt: this.now() });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}
