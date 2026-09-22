export interface RenderIntent {
  rendererId: string;
  raw: boolean;
}

/** Tab-only, bounded intent memory. Reads never extend the explicit-choice TTL. */
export class RenderIntentMemory {
  private readonly entries = new Map<string, { source: string; intent: RenderIntent; chosenAt: number }>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly limit = 128, private readonly ttl = 15 * 60_000) {}

  read(key: string, source: string, availableIds: readonly string[]): RenderIntent | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.source !== source || this.now() - entry.chosenAt >= this.ttl || !availableIds.includes(entry.intent.rendererId)) {
      this.entries.delete(key);
      return undefined;
    }
    return { ...entry.intent };
  }

  choose(key: string, source: string, intent: RenderIntent): void {
    this.entries.delete(key);
    this.entries.set(key, { source, intent: { ...intent }, chosenAt: this.now() });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export const renderIntentMemory = new RenderIntentMemory();
