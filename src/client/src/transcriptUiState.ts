/** Small presentation choices only; transcript content and DOM belong to their owners. */
export interface ToolUiIntent {
  textOpen?: boolean;
  diffOpen?: boolean;
  showFullDiff?: boolean;
}

/** Instance-owned, least-recently-used tool intents keyed by caller-supplied identity. */
export class TranscriptUiState {
  private readonly tools = new Map<string, Readonly<ToolUiIntent>>();

  constructor(private readonly maxTools = 512) {
    if (!Number.isSafeInteger(maxTools) || maxTools < 1) throw new RangeError("maxTools must be a positive safe integer");
  }

  getTool(key: string): Readonly<ToolUiIntent> | undefined {
    const intent = this.tools.get(key);
    if (intent !== undefined) {
      this.tools.delete(key);
      this.tools.set(key, intent);
    }
    return intent;
  }

  setTool(key: string, patch: ToolUiIntent): void {
    const intent = { ...this.tools.get(key) };
    // Copy only supported booleans, even at untyped caller boundaries.
    for (const field of ["textOpen", "diffOpen", "showFullDiff"] as const) {
      if (typeof patch[field] === "boolean") intent[field] = patch[field];
    }
    this.tools.delete(key);
    this.tools.set(key, Object.freeze(intent));
    if (this.tools.size > this.maxTools) {
      const oldest = this.tools.keys().next();
      if (oldest.done !== true) this.tools.delete(oldest.value);
    }
  }
}
