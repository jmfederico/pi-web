import type { PluginPromptChip } from "../../plugin-api";

export interface PromptChipTarget {
  readonly machineId: string;
  readonly sessionId: string;
}

/** Immutable version of a plugin-owned chip. Identity protects newer edits during Send. */
export interface StagedPromptChip extends PluginPromptChip {
  readonly pluginId: string;
  readonly target: PromptChipTarget;
  readonly key: string;
}

export class PromptChipStore {
  private readonly chips = new Map<string, StagedPromptChip>();

  constructor(private readonly onChanged: () => void = () => undefined) {}

  set(pluginId: string, target: PromptChipTarget, chip: PluginPromptChip): void {
    for (const [name, value] of [["id", chip.id], ["label", chip.label], ["text", chip.text]] as const) {
      if (typeof value !== "string" || value.trim() === "") throw new TypeError(`Prompt chip ${name} must be a non-empty string`);
    }
    if (chip.onRemove !== undefined && typeof chip.onRemove !== "function") throw new TypeError("Prompt chip onRemove must be a function");
    const key = chipKey(pluginId, target, chip.id);
    this.chips.set(key, Object.freeze({
      id: chip.id, label: chip.label, text: chip.text,
      ...(chip.onRemove === undefined ? {} : { onRemove: chip.onRemove }),
      pluginId, target: Object.freeze({ ...target }), key,
    }));
    this.onChanged();
  }

  remove(pluginId: string, target: PromptChipTarget, id: string): void {
    if (this.chips.delete(chipKey(pluginId, target, id))) this.onChanged();
  }

  list(target: PromptChipTarget): readonly StagedPromptChip[] {
    return [...this.chips.values()].filter((chip) => samePromptChipTarget(chip.target, target));
  }

  removeByUser(chip: StagedPromptChip): void {
    if (this.chips.get(chip.key) !== chip) return;
    this.chips.delete(chip.key);
    this.onChanged();
    notifyRemoval(chip, "user");
  }

  consume(submitted: readonly StagedPromptChip[]): void {
    for (const chip of submitted) {
      // A plugin may update/withdraw its chip while the request is in flight.
      // Only the submitted version is consumed, never a replacement.
      if (this.chips.get(chip.key) === chip) this.chips.delete(chip.key);
    }
    this.onChanged();
    for (const chip of submitted) notifyRemoval(chip, "submitted");
  }

  clear(): void {
    this.chips.clear();
    this.onChanged();
  }
}

export function samePromptChipTarget(a: PromptChipTarget, b: PromptChipTarget): boolean {
  return a.machineId === b.machineId && a.sessionId === b.sessionId;
}

export function appendPromptChipText(text: string, chips: readonly StagedPromptChip[]): string {
  return [...(text === "" ? [] : [text]), ...chips.map((chip) => chip.text)].join("\n\n");
}

function chipKey(pluginId: string, target: PromptChipTarget, id: string): string {
  return JSON.stringify([target.machineId, target.sessionId, pluginId, id]);
}

function notifyRemoval(chip: StagedPromptChip, reason: "user" | "submitted"): void {
  try {
    const result = chip.onRemove?.(reason);
    void Promise.resolve(result).catch((error: unknown) => { console.warn(`Failed to notify prompt chip owner ${chip.pluginId}`, error); });
  } catch (error) {
    console.warn(`Failed to notify prompt chip owner ${chip.pluginId}`, error);
  }
}
