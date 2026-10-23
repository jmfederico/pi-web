import { describe, expect, it, vi } from "vitest";
import { html } from "lit";
import type { ContentRendererContributionV5 as ContentRendererContribution } from "../../../plugin-api";
import { PluginRegistry } from "./registry";
import { contentRendererMatches, snapshotContentRenderer } from "./contentRenderers";
import { contentRenderingCapabilityToken } from "../formatting/contentRendering";

function contribution(): ContentRendererContribution {
  return { id: "diagram", languages: ["Mermaid"], fileExtensions: ["MMD"], render: ({ text }) => html`${text}` };
}

function plugin() {
  return { apiVersion: 5 as const, name: "Diagram", activate: () => ({ contributions: { contentRenderers: [contribution()] } }) };
}

const request = { machineId: "remote", text: "graph TD", language: "MERMAID extra" };

describe("content renderer registry", () => {
  it("retains discovery order when imports finish in reverse and activation runs by ID", async () => {
    const registry = new PluginRegistry();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const completed: import("./types").PiWebPluginRegistration[] = [];
    const first = new Promise<void>((resolve) => { finishFirst = resolve; }).then(() => { completed.push({ id: "z-first", plugin: plugin() }); });
    const second = new Promise<void>((resolve) => { finishSecond = resolve; }).then(() => { completed.push({ id: "a-second", plugin: plugin() }); });
    finishSecond();
    await second;
    finishFirst();
    await first;
    const result = await registry.registerBatch(completed, { declarations: [{ id: "z-first" }, { id: "a-second" }] });
    expect(result.failures).toEqual([]);
    expect(registry.contentRendering.listRenderers(request).map(({ id }) => id)).toEqual(["z-first:diagram", "a-second:diagram"]);
    await registry.dispose();
  });

  it("validates dynamic eligibility and titles, restricts selectors, and isolates supports failures", async () => {
    const registry = new PluginRegistry();
    const supports = vi.fn((value: import("../../../plugin-api").ContentRenderRequest) => value.machineId === "remote");
    await registry.register({ id: "dynamic", plugin: { ...plugin(), activate: () => ({ contributions: { contentRenderers: [
      { id: "dynamic", title: "Highlighted", supports, render: () => html`preview` },
      { ...contribution(), id: "restricted", supports: () => false },
      { ...contribution(), id: "broken", supports: () => { throw new Error("bad eligibility"); } },
    ] } }) } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(registry.contentRendering.listRenderers(request)).toEqual([{ id: "dynamic:dynamic", label: "Highlighted", title: "Highlighted", renderMode: "manual" }]);
    expect(supports).toHaveBeenCalledWith(request);
    expect(warn).toHaveBeenCalledWith("Content renderer eligibility failed", expect.anything(), expect.any(Error));
    warn.mockRestore();
    for (const [key, value] of [["supports", true], ["title", 12], ["title", " "]] as const) {
      const invalid = contribution();
      Reflect.set(invalid, key, value);
      expect(() => snapshotContentRenderer(invalid)).toThrow(key);
    }
    await registry.dispose();
  });
  it("does not call retained eligibility callbacks after the owning plugin shuts down", async () => {
    const registry = new PluginRegistry();
    const supports = vi.fn(() => true);
    await registry.register({ id: "owner", plugin: { ...plugin(), activate: () => ({ contributions: {
      contentRenderers: [{ ...contribution(), supports }],
    } }) } });
    const retained = registry.matchContentRenderers(request)[0];
    if (retained === undefined) throw new Error("Expected matching renderer");
    supports.mockClear();
    registry.beginShutdown();
    expect(contentRendererMatches(retained.renderer, request)).toBe(false);
    expect(supports).not.toHaveBeenCalled();
    await registry.dispose();
  });

  it("excludes asynchronous eligibility and consumes rejection without breaking source rendering", async () => {
    const invalid = contribution();
    const failure = new Error("async eligibility failed");
    Reflect.set(invalid, "supports", () => Promise.reject(failure));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(contentRendererMatches(snapshotContentRenderer(invalid), request)).toBe(false);
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith("Content renderer eligibility failed", expect.anything(), failure);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps each machine's rendering input stable until its eligible renderer set changes", async () => {
    const registry = new PluginRegistry();
    const capability = registry.contentRendering;
    const local = registry.getChatContentRendering("local");
    const remote = registry.getChatContentRendering("remote");
    expect(registry.getChatContentRendering("local")).toBe(local);
    expect(registry.getChatContentRendering("remote")).toBe(remote);
    await registry.register({ id: "unrelated", plugin: { apiVersion: 4, name: "Unrelated", activate: () => ({ contributions: {} }) } });
    expect(registry.getChatContentRendering("local")).toBe(local);
    await registry.register({ id: "local-diagram", machineId: "local", machineSpecific: true, plugin: plugin() });
    const available = registry.getChatContentRendering("local");
    expect(available).not.toBe(local);
    expect(registry.getChatContentRendering("local")).toBe(available);
    expect(registry.getChatContentRendering("remote")).toBe(remote);
    // Retained public capabilities keep querying the live registry, not a chat snapshot.
    expect(registry.contentRendering).toBe(capability);
    expect(capability.listRenderers({ ...request, machineId: "local" })).toHaveLength(1);
    expect(capability.listRenderers(request)).toEqual([]);
    await registry.dispose();
    expect(registry.getChatContentRendering("local")).not.toBe(available);
    expect(capability.listRenderers({ ...request, machineId: "local" })).toEqual([]);
  });

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
    const localView = registry.getChatContentRendering("local");
    const remoteView = registry.getChatContentRendering("remote");
    await registry.register({ id: "remote-diagram", sourcePluginId: "local-diagram", machineId: "remote", machineSpecific: true, plugin: plugin() });
    const activeRemoteView = registry.getChatContentRendering("remote");
    expect(activeRemoteView).not.toBe(remoteView);
    expect(registry.getChatContentRendering("local")).toBe(localView);
    expect(registry.matchContentRenderers(request)[0]?.renderer.id).toBe("remote-diagram:diagram");
    expect(registry.matchContentRenderers({ ...request, machineId: "local" })[0]?.renderer.id).toBe("local-diagram:diagram");
    expect(registry.matchContentRenderers({ ...request, machineId: "other" })).toEqual([]);
    enabled = false;
    const unavailableView = registry.getChatContentRendering("remote");
    expect(unavailableView).not.toBe(activeRemoteView);
    expect(registry.getChatContentRendering("remote")).toBe(unavailableView);
    expect(registry.matchContentRenderers(request)).toEqual([]);
    expect(gate).toHaveBeenCalledWith("remote-diagram", "remote");
    enabled = true;
    expect(registry.getChatContentRendering("remote")).not.toBe(unavailableView);
    await registry.dispose();
    expect(registry.matchContentRenderers(request)).toEqual([]);
  });

  it("orders by discovery and contribution declaration, not qualified IDs", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "aaa-runtime", sourcePluginId: "z-plugin", machineId: "remote", plugin: plugin() });
    await registry.register({ id: "zzz-runtime", sourcePluginId: "a-plugin", machineId: "remote", plugin: {
      ...plugin(), activate: () => ({ contributions: { contentRenderers: [
        { ...contribution(), id: "z-last" }, { ...contribution(), id: "a-first" },
      ] } }),
    } });
    expect(registry.contentRendering.listRenderers(request)).toEqual([
      { id: "aaa-runtime:diagram", label: "z-plugin / diagram", renderMode: "manual" },
      { id: "zzz-runtime:z-last", label: "a-plugin / z-last", renderMode: "manual" },
      { id: "zzz-runtime:a-first", label: "a-plugin / a-first", renderMode: "manual" },
    ]);
  });

  it("sorts duplicate claims and does not publish failed-start renderers", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "one", plugin: plugin() });
    await registry.register({ id: "two", plugin: plugin() });
    expect(registry.matchContentRenderers(request).map(({ id }) => id)).toEqual(["one:diagram", "two:diagram"]);
    const rendering = registry.getChatContentRendering(request.machineId);
    await expect(registry.register({ id: "failed", plugin: { ...plugin(), activate: () => ({ contributions: { contentRenderers: [contribution()] }, start: () => { throw new Error("start failure"); } }) } })).rejects.toThrow("start failure");
    expect(registry.getChatContentRendering(request.machineId)).toBe(rendering);
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
