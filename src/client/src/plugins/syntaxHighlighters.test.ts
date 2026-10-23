import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { SyntaxHighlighterContribution } from "../../../plugin-api";
import { PluginRegistry } from "./registry";
import { adaptPublicPlugin } from "./publicContext";
import { syntaxHighlightingCapabilityToken } from "../formatting/syntaxHighlighting";

const request = { machineId: "remote", text: "abc", language: "TEST extra", signal: new AbortController().signal };
const highlighter = (id = "syntax"): SyntaxHighlighterContribution => ({
  id, languages: ["Test"], fileExtensions: ["TEST"], highlight: () => [{ from: 0, to: 1, kind: "keyword" }],
});
const plugin = (syntaxHighlighters = [highlighter()]) => adaptPublicPlugin({
  apiVersion: 5, name: "Test", activate: () => ({ contributions: { syntaxHighlighters } }),
});

describe("syntax highlighter registry", () => {
  it("exposes a versioned host capability and returns undefined only for no match", async () => {
    const registry = new PluginRegistry();
    const resolved = vi.fn();
    await registry.register({ id: "consumer", plugin: {
      ...plugin([]), requires: [syntaxHighlightingCapabilityToken],
      activate: () => ({ contributions: {}, start: ({ capabilities }) => { resolved(capabilities.resolve(syntaxHighlightingCapabilityToken)); } }),
    } });
    expect(resolved).toHaveBeenCalledWith(registry.syntaxHighlighting);
    expect(await registry.syntaxHighlighting.highlight(request)).toBeUndefined();
    expect(registry.syntaxHighlighting.supports(request)).toBe(false);
    await registry.register({ id: "test", plugin: plugin() });
    expect(await registry.syntaxHighlighting.highlight(request)).toEqual([{ from: 0, to: 1, kind: "keyword" }]);
    expect(await registry.syntaxHighlighting.highlight({ ...request, language: "other", filePath: "dir.test/no" })).toBeUndefined();
    expect(await registry.syntaxHighlighting.highlight({ ...request, language: "other", filePath: "dir/a.TEST" })).toHaveLength(1);
    await registry.dispose();
    expect(await registry.syntaxHighlighting.highlight(request)).toBeUndefined();
  });

  it("uses last discovered grammar, snapshots selectors, and never creates renderers", async () => {
    const registry = new PluginRegistry();
    const highlight = vi.fn(() => []);
    const source = { ...highlighter(), highlight };
    await registry.register({ id: "aaa", sourcePluginId: "z-source", plugin: plugin([source]) });
    source.languages = ["changed"];
    const last = vi.fn(() => []);
    await registry.register({ id: "zzz", sourcePluginId: "a-source", plugin: plugin([highlighter("z"), { ...highlighter("a"), highlight: last }]) });
    expect(registry.contentRendering.listRenderers(request)).toEqual([]);
    expect(registry.syntaxHighlighting.supports(request)).toBe(true);
    expect(highlight).not.toHaveBeenCalled();
    expect(registry.matchContentRenderers(request)).toHaveLength(0);
    await registry.syntaxHighlighting.highlight(request);
    expect(last).toHaveBeenCalledOnce();
    expect(highlight).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("uses source-machine precedence and the effective-machine enablement gate for both capabilities", async () => {
    let enabled = true;
    const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
    await registry.register({ id: "local-syntax", sourcePluginId: "syntax", machineSpecific: true, plugin: plugin() });
    await registry.register({ id: "remote-syntax", sourcePluginId: "local-syntax", machineId: "remote", machineSpecific: true, plugin: plugin() });
    expect(registry.syntaxHighlighting.supports(request)).toBe(true);
    expect(await registry.syntaxHighlighting.highlight(request)).toHaveLength(1);
    expect(await registry.syntaxHighlighting.highlight({ ...request, machineId: "other" })).toBeUndefined();
    expect(await registry.syntaxHighlighting.highlight({ ...request, machineId: "local" })).toHaveLength(1);
    enabled = false;
    expect(await registry.syntaxHighlighting.highlight(request)).toBeUndefined();
    expect(registry.syntaxHighlighting.supports(request)).toBe(false);
    expect(registry.matchContentRenderers(request)).toEqual([]);
    await registry.dispose();
  });

  it("rolls back invalid selectors, duplicate IDs across contribution types, and failed starts", async () => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "invalid", plugin: plugin([{ ...highlighter(), languages: [""] }]) })).rejects.toThrow("selectors");
    await expect(registry.register({ id: "duplicate", plugin: plugin([highlighter(), highlighter()]) })).rejects.toThrow("Duplicate contribution id");
    await expect(registry.register({ id: "collision", plugin: { ...plugin(), activate: () => ({ contributions: {
      syntaxHighlighters: [highlighter()], contentRenderers: [{ id: "syntax", languages: ["test"], render: () => html`text` }],
    } }) } })).rejects.toThrow("Duplicate contribution id");
    await expect(registry.register({ id: "failed", plugin: { ...plugin(), activate: () => ({ contributions: { syntaxHighlighters: [highlighter()] }, start: () => { throw new Error("failed start"); } }) } })).rejects.toThrow("failed start");
    expect(await registry.syntaxHighlighting.highlight(request)).toBeUndefined();
    expect(registry.matchContentRenderers(request)).toEqual([]);
    await registry.dispose();
  });

  it("does not hide a selected plugin failure by trying another matching highlighter", async () => {
    const registry = new PluginRegistry();
    const fallback = vi.fn(() => []);
    const failure = new Error("parser failed");
    await registry.register({ id: "b", plugin: plugin([{ ...highlighter(), highlight: fallback }]) });
    await registry.register({ id: "a", plugin: plugin([{ ...highlighter(), highlight: () => Promise.reject(failure) }]) });
    await expect(registry.syntaxHighlighting.highlight(request)).rejects.toMatchObject({ message: "Syntax highlighter a:syntax failed", cause: failure });
    expect(fallback).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("aborts in-flight work on shutdown and removes grammar eligibility", async () => {
    let signal: AbortSignal | undefined;
    const highlight = vi.fn((input: { text: string; signal: AbortSignal }) => {
      signal = input.signal;
      return new Promise<readonly never[]>(() => { /* Deliberately ignores cancellation. */ });
    });
    const registry = new PluginRegistry();
    await registry.register({ id: "owner", plugin: plugin([{ ...highlighter(), highlight }]) });
    const result = registry.syntaxHighlighting.highlight(request);
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    registry.beginShutdown();
    expect(signal?.aborted).toBe(true);
    await rejection;
    expect(registry.syntaxHighlighting.supports(request)).toBe(false);
    expect(highlight).toHaveBeenCalledTimes(1);
    await registry.dispose();
  });
});
