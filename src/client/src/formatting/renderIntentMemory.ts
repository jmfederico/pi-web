import { TransientChoiceMemory } from "./transientChoiceMemory";

export interface RenderIntent {
  rendererId: string;
  raw: boolean;
}

/** Tab-only intent memory: unavailable renderers invalidate their saved choice. */
export class RenderIntentMemory {
  private readonly memory: TransientChoiceMemory<RenderIntent>;

  constructor(now?: () => number, limit?: number, ttl?: number) {
    this.memory = new TransientChoiceMemory(now, limit, ttl);
  }

  read(key: string, source: string, availableIds: readonly string[]): RenderIntent | undefined {
    const intent = this.memory.read(key, source);
    if (intent === undefined) return undefined;
    if (!availableIds.includes(intent.rendererId)) {
      this.memory.delete(key);
      return undefined;
    }
    return { ...intent };
  }

  choose(key: string, source: string, intent: RenderIntent): void {
    this.memory.choose(key, source, { ...intent });
  }
}

export const renderIntentMemory = new RenderIntentMemory();
