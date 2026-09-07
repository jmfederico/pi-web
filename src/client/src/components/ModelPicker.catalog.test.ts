import { describe, expect, it } from "vitest";
import type { CommandOption, SessionModelCatalogEntry } from "../api";
import { filterModelOptions, modelCatalogEntryValue, modelCatalogToggleAllPlan, modelCatalogView } from "./ModelPicker";

function entry(provider: string, id: string, enabled: boolean, name?: string, catalogIndex?: number): SessionModelCatalogEntry {
  return { provider, id, enabled, ...(name === undefined ? {} : { name }), ...(catalogIndex === undefined ? {} : { catalogIndex }) };
}

const catalog: SessionModelCatalogEntry[] = [
  entry("openai", "gpt-5", true),
  entry("anthropic", "claude-sonnet-4-5", true, "Claude Sonnet 4.5"),
  entry("openai", "gpt-4o", false),
  entry("google", "gemini-2.5-pro", false),
];

describe("filterModelOptions", () => {
  it("returns the options untouched in order for a blank query", () => {
    const options: CommandOption[] = [{ value: "openai/gpt-5", label: "gpt-5" }, { value: "anthropic/claude", label: "claude", description: "anthropic" }];

    expect(filterModelOptions(options, "  ")).toEqual(options);
  });

  it("matches label, description, and value case-insensitively and preserves order", () => {
    const options: CommandOption[] = [
      { value: "openai/gpt-5", label: "gpt-5", description: "openai" },
      { value: "anthropic/claude", label: "claude", description: "anthropic" },
      { value: "google/gemini", label: "gemini", description: "google" },
    ];

    expect(filterModelOptions(options, "ANTHROPIC").map((option) => option.value)).toEqual(["anthropic/claude"]);
    expect(filterModelOptions(options, "openai/g").map((option) => option.value)).toEqual(["openai/gpt-5"]);
    expect(filterModelOptions(options, "gpt").map((option) => option.value)).toEqual(["openai/gpt-5"]);
  });
});

describe("modelCatalogToggleAllPlan", () => {
  it("narrows any non-empty multi-model selection to the current model", () => {
    expect(modelCatalogToggleAllPlan(catalog, "openai/gpt-5")).toEqual({
      mode: "current",
      canApply: true,
      hasChanges: true,
    });
  });

  it("selects every model when none or only the current model is enabled", () => {
    const disabledCatalog = catalog.map((row) => ({ ...row, enabled: false }));
    const onlyCurrentCatalog = disabledCatalog.map((row) => ({ ...row, enabled: modelCatalogEntryValue(row) === "openai/gpt-5" }));

    expect(modelCatalogToggleAllPlan(disabledCatalog, "openai/gpt-5")).toEqual({ mode: "all", canApply: true, hasChanges: true });
    expect(modelCatalogToggleAllPlan(onlyCurrentCatalog, "openai/gpt-5")).toEqual({ mode: "all", canApply: true, hasChanges: true });
  });

  it("cannot narrow the scope when the current model is unavailable", () => {
    expect(modelCatalogToggleAllPlan(catalog, "missing/model")).toEqual({ mode: "current", canApply: false, hasChanges: false });
  });
});

describe("modelCatalogView", () => {
  it("restores natural machine-catalog order from catalog indexes", () => {
    const indexed = [
      entry("openai", "gpt-5", true, undefined, 2),
      entry("anthropic", "claude-sonnet-4-5", true, "Claude Sonnet 4.5", 0),
      entry("openai", "gpt-4o", false, undefined, 1),
      entry("google", "gemini-2.5-pro", false, undefined, 3),
    ];

    expect(modelCatalogView(indexed, "").rows.map(modelCatalogEntryValue)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "openai/gpt-4o",
      "openai/gpt-5",
      "google/gemini-2.5-pro",
    ]);
  });

  it("filters by provider, id, and display name case-insensitively, preserving natural order", () => {
    expect(modelCatalogView(catalog, "gpt").rows.map(modelCatalogEntryValue)).toEqual(["openai/gpt-5", "openai/gpt-4o"]);
    expect(modelCatalogView(catalog, "GOOGLE").rows.map(modelCatalogEntryValue)).toEqual(["google/gemini-2.5-pro"]);
    expect(modelCatalogView(catalog, "sonnet 4.5").rows.map(modelCatalogEntryValue)).toEqual(["anthropic/claude-sonnet-4-5"]);
  });

  it("honors a dialog-owned stable order when a response regroups rows", () => {
    const stableOrder = catalog.map(modelCatalogEntryValue);
    const regrouped = [
      entry("openai", "gpt-4o", false),
      entry("openai", "gpt-5", true),
      entry("google", "gemini-2.5-pro", false),
      entry("anthropic", "claude-sonnet-4-5", true, "Claude Sonnet 4.5"),
    ];

    expect(modelCatalogView(regrouped, "", stableOrder).rows.map(modelCatalogEntryValue)).toEqual(stableOrder);
  });
});
