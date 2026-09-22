import { describe, expect, it, vi } from "vitest";
import { html } from "lit";
import type { ContentRendererContribution } from "../../../plugin-api";
import { PluginRegistry } from "./registry";
import { snapshotContentRenderer } from "./contentRenderers";
import { contentRenderingCapabilityToken } from "../formatting/contentRendering";

function contribution(): ContentRendererContribution {
  return { id: "diagram", languages: ["Mermaid"], fileExtensions: ["MMD"], render: ({ text }) => html`${text}` };
}

function plugin() {
  return { apiVersion: 4 as const, name: "Diagram", activate: () => ({ contributions: { contentRenderers: [contribution()] } }) };
}

const request = { machineId: "remote", text: "graph TD", language: "MERMAID extra" };

describe("content renderer registry", () => {
  it("normalizes selectors and matches complete file extensions, not arbitrary path suffixes", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "diagram", plugin: plugin() });
    expect(registry.matchContentRenderers(request)[0]?.renderer.id).toBe("diagram:diagram");
    expect(registry.matchContentRenderers({ ...request, language: "unknown", filePath: "folder.mmd/test.MMD" })[0]?.renderer.id).toBe("diagram:diagram");
    expect(registry.matchContentRenderers({ ...request, language: "unknown", filePath: "folder.mmd/file" })).toEqual([]);
    const input = contribution();
    const snapshot = snapshotContentRenderer(input);
    input.languages = ["other"];
    expect(snapshot.languages).toEqual(["mermaid"]);
  });

  it("uses the existing portable/machine-specific precedence and effective-machine lifecycle gate", async () => {
    let enabled = true;
    const gate = vi.fn(() => enabled);
    const registry = new PluginRegistry({ isContributionEnabled: gate });
    await registry.register({ id: "local-diagram", sourcePluginId: "diagram", machineSpecific: true, plugin: plugin() });
    await registry.register({ id: "remote-diagram", sourcePluginId: "local-diagram", machineId: "remote", machineSpecific: true, plugin: plugin() });
    expect(registry.matchContentRenderers(request)[0]?.renderer.id).toBe("remote-diagram:diagram");
    expect(registry.matchContentRenderers({ ...request, machineId: "local" })[0]?.renderer.id).toBe("local-diagram:diagram");
    expect(registry.matchContentRenderers({ ...request, machineId: "other" })).toEqual([]);
    enabled = false;
    expect(registry.matchContentRenderers(request)).toEqual([]);
    expect(gate).toHaveBeenCalledWith("remote-diagram", "remote");
    enabled = true;
    await registry.dispose();
    expect(registry.matchContentRenderers(request)).toEqual([]);
  });

  it("orders by stable source plugin ID, then local ID, not remote prefix or registration order", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "aaa-runtime", sourcePluginId: "z-plugin", machineId: "remote", plugin: plugin() });
    await registry.register({ id: "zzz-runtime", sourcePluginId: "a-plugin", machineId: "remote", plugin: {
      ...plugin(), activate: () => ({ contributions: { contentRenderers: [
        { ...contribution(), id: "z-last" }, { ...contribution(), id: "a-first" },
      ] } }),
    } });
    expect(registry.contentRendering.listRenderers(request)).toEqual([
      { id: "zzz-runtime:a-first", label: "a-plugin / a-first", renderMode: "manual" },
      { id: "zzz-runtime:z-last", label: "a-plugin / z-last", renderMode: "manual" },
      { id: "aaa-runtime:diagram", label: "z-plugin / diagram", renderMode: "manual" },
    ]);
  });

  it("sorts duplicate claims and does not publish failed-start renderers", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "one", plugin: plugin() });
    await registry.register({ id: "two", plugin: plugin() });
    expect(registry.matchContentRenderers(request).map(({ id }) => id)).toEqual(["one:diagram", "two:diagram"]);
    await expect(registry.register({ id: "failed", plugin: { ...plugin(), activate: () => ({ contributions: { contentRenderers: [contribution()] }, start: () => { throw new Error("start failure"); } }) } })).rejects.toThrow("start failure");
    expect(registry.matchContentRenderers(request).map(({ id }) => id)).toEqual(["one:diagram", "two:diagram"]);
  });

  it("aborts active renderer work and ignores late failures when the owning plugin shuts down", async () => {
    let input: import("../../../plugin-api").ContentRendererInput | undefined;
    const registry = new PluginRegistry();
    await registry.register({ id: "owner", plugin: { apiVersion: 4, name: "Owner", activate: () => ({ contributions: { contentRenderers: [{ ...contribution(), render: (value) => { input = value; return html`preview`; } }] } }) } });
    const fail = vi.fn();
    registry.matchContentRenderers(request)[0]?.renderer.render({ text: request.text, signal: new AbortController().signal, fail });
    expect(input?.signal.aborted).toBe(false);
    registry.beginShutdown();
    expect(input?.signal.aborted).toBe(true);
    input?.fail(new Error("late"));
    expect(fail).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("provides the exact versioned public host capability through requires/start", async () => {
    const registry = new PluginRegistry();
    const resolved = vi.fn();
    await registry.register({ id: "consumer", plugin: { apiVersion: 4, name: "Consumer", requires: [contentRenderingCapabilityToken], activate: () => ({ contributions: {}, start: ({ capabilities }) => { resolved(capabilities.resolve(contentRenderingCapabilityToken)); } }) } });
    expect(resolved).toHaveBeenCalledWith(registry.contentRendering);
    await expect(registry.register({ id: "wrong", plugin: { apiVersion: 4, name: "Wrong", requires: [{ ...contentRenderingCapabilityToken, version: 2 }], activate: () => ({ contributions: {} }) } })).rejects.toThrow("requires unavailable capability");
  });

  it("validates and snapshots activation policy without invoking render while listing or probing", async () => {
    const draw = vi.fn(() => html`preview`);
    const registry = new PluginRegistry();
    await registry.register({ id: "manual", plugin: { ...plugin(), activate: () => ({ contributions: { contentRenderers: [{ ...contribution(), render: draw }] } }) } });
    registry.contentRendering.listRenderers(request);
    registry.contentRendering.renderText(request);
    expect(draw).not.toHaveBeenCalled();
    expect(snapshotContentRenderer(contribution()).renderMode).toBe("manual");
    expect(snapshotContentRenderer({ ...contribution(), renderMode: "automatic" }).renderMode).toBe("automatic");
    const invalid = contribution();
    Reflect.set(invalid, "renderMode", "invalid");
    expect(() => snapshotContentRenderer(invalid)).toThrow("renderMode");
  });

  it("rejects invalid selectors and contribution id collisions transactionally", async () => {
    expect(() => snapshotContentRenderer({ ...contribution(), languages: [""] })).toThrow("selectors");
    expect(() => snapshotContentRenderer({ ...contribution(), fileExtensions: [".mmd"] })).toThrow("selectors");
    expect(() => snapshotContentRenderer({ ...contribution(), languages: [], fileExtensions: [] })).toThrow("selector");
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "bad", plugin: { ...plugin(), activate: () => ({ contributions: { contentRenderers: [contribution(), contribution()] } }) } })).rejects.toThrow("Duplicate contribution id");
    expect(registry.matchContentRenderers(request)).toEqual([]);
  });
});
