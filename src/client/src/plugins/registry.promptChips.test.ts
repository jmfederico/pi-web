import { expect, it, vi } from "vitest";
import { PluginRegistry } from "./registry";

it("rejects chip mutations without an active owner/target and ends retained facades at shutdown", async () => {
  let enabled = true;
  const changed = vi.fn();
  const registry = new PluginRegistry({ isContributionEnabled: () => enabled, onPromptChipsChanged: changed });
  const target = { machineId: "local", sessionId: "conversation" };
  const chip = { id: "note", label: "Note", text: "Context" };
  const prompt = registry.promptChipMethods("source", target);
  expect(() => prompt.setChip?.(chip)).toThrow("unavailable");
  await registry.register({ id: "source", plugin: { apiVersion: 4, name: "Source", activate: () => ({ contributions: {} }) } });
  expect(() => registry.promptChipMethods("source", undefined).setChip?.(chip)).toThrow("ready, non-archived");
  prompt.setChip?.(chip);
  expect(changed).toHaveBeenCalledOnce();
  enabled = false;
  expect(() => prompt.setChip?.(chip)).toThrow("unavailable");
  expect(registry.promptChipOwnerAvailable("source", "local")).toBe(false);
  registry.beginShutdown();
  expect(registry.promptChips.list(target)).toEqual([]);
  expect(() => prompt.setChip?.(chip)).toThrow("unavailable");
  await registry.dispose();
});

it("uses the same portable/machine-specific precedence as plugin contributions", async () => {
  const registry = new PluginRegistry();
  const plugin = { apiVersion: 4 as const, name: "Source", activate: () => ({ contributions: {} }) };
  await registry.register({ id: "source", plugin });
  await registry.register({ id: "remote-source", sourcePluginId: "source", machineId: "remote", machineSpecific: true, plugin });
  expect(registry.promptChipOwnerAvailable("source", "local")).toBe(true);
  expect(registry.promptChipOwnerAvailable("source", "remote")).toBe(false);
  expect(registry.promptChipOwnerAvailable("remote-source", "local")).toBe(false);
  expect(registry.promptChipOwnerAvailable("remote-source", "remote")).toBe(true);
  await registry.dispose();
});
