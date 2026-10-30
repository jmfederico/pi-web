import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptRendererContribution, TranscriptToolRenderer, TranscriptToolRendererInput, TranscriptToolRendererResolver } from "../../../plugin-api";
import { PluginRegistry } from "./registry";
import { adaptPublicPlugin } from "./publicContext";
import { resolveTranscriptToolRenderer, snapshotTranscriptRenderer, transcriptRenderingCapability, transcriptRenderingCapabilityToken, type RegisteredTranscriptRenderer } from "./transcriptRenderers";

const tool = (id = "tool", name = "read"): TranscriptRendererContribution => ({ id, target: "tool", resolve: (toolName, next) => toolName === name ? { render: () => html`tool` } : next() });
const custom = (id: string, customType = "notice"): TranscriptRendererContribution => ({ id, target: "custom-message", customType, render: () => undefined });
const plugin = (transcriptRenderers = [tool()]) => adaptPublicPlugin({ apiVersion: 5, name: "Test", activate: () => ({ contributions: { transcriptRenderers } }) });
const input = (): TranscriptToolRendererInput => ({ scope: { machineId: "local", sessionId: "session" }, entry: { toolName: "read", status: "success" }, signal: new AbortController().signal, fail: vi.fn() });

function asTool(renderer: TranscriptRendererContribution | undefined) {
  if (renderer?.target !== "tool") throw new Error("Expected tool renderer");
  return renderer;
}

function registered(id: string, resolve: TranscriptToolRendererResolver): RegisteredTranscriptRenderer {
  return { id, localId: id, pluginId: "test", target: "tool", resolve };
}

describe("tool resolution chain", () => {
  it("delegates in order, skips custom messages, and permits wrapping an optional base", () => {
    const calls: string[] = [];
    const baseRender = vi.fn(() => html`base`);
    const baseRenderer: TranscriptToolRenderer = { render: baseRender };
    const base = vi.fn(() => { calls.push("base"); return baseRenderer; });
    const renderers = [
      registered("nonmatch", (name, next) => { calls.push(name); return next(); }),
      { ...custom("custom"), pluginId: "test", localId: "custom" },
      registered("wrapper", (_name, next) => {
        calls.push("wrapper");
        const inner = next();
        return { render: (value) => html`wrapped ${inner?.render(value)}` };
      }),
      registered("delegate", (_name, next) => { calls.push("delegate"); return next(); }),
    ];
    const renderer = resolveTranscriptToolRenderer("anything", renderers, base);
    expect(calls).toEqual(["anything", "wrapper", "delegate", "base"]);
    expect(base).toHaveBeenCalledTimes(1);
    const value = input();
    expect(renderer?.render(value)).toBeDefined();
    expect(baseRender).toHaveBeenCalledWith(value);
    expect(resolveTranscriptToolRenderer("anything", [])).toBeUndefined();
    expect(resolveTranscriptToolRenderer("anything", [], base)).toBe(baseRenderer);
  });

  it("preserves delegated base identity and receiver without attaching the delegator lifetime", () => {
    const lifetime = new AbortController();
    const baseRender = vi.fn(function (this: TranscriptToolRenderer, value: TranscriptToolRendererInput) {
      expect(this).toBe(base);
      return html`${value.entry.toolName}`;
    });
    const base: TranscriptToolRenderer = { render: baseRender };
    const another: TranscriptToolRenderer = { render: () => html`another` };
    const next = vi.fn<() => TranscriptToolRenderer>().mockReturnValueOnce(base).mockReturnValueOnce(another);
    const contribution = asTool(snapshotTranscriptRenderer({ id: "delegate", target: "tool", resolve: (_name, next) => {
      const first = next();
      next();
      return first;
    } }, lifetime.signal));
    const resolved = contribution.resolve("read", next);
    expect(resolved).toBe(base);
    lifetime.abort();
    const value = input();
    expect(resolved?.render(value)).toBeDefined();
    expect(baseRender).toHaveBeenCalledExactlyOnceWith(value);
    expect(value.signal.aborted).toBe(false);
    expect(contribution.resolve("read", next)).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("gives the first resolver refusal and does not delegate implicitly", () => {
    const downstream = vi.fn(() => ({ render: () => html`later` }));
    const replacement = { render: () => html`first` };
    expect(resolveTranscriptToolRenderer("read", [registered("first", () => replacement), registered("later", downstream)])).toBe(replacement);
    expect(downstream).not.toHaveBeenCalled();
    expect(resolveTranscriptToolRenderer("read", [registered("first", () => undefined), registered("later", downstream)])).toBeUndefined();
    expect(downstream).not.toHaveBeenCalled();
  });
});

describe("transcript renderer registry", () => {
  it("activates the detection capability, retains all tools and first custom matches, and snapshots callbacks", async () => {
    const registry = new PluginRegistry();
    const source = tool();
    const message = custom("message");
    const resolved = vi.fn();
    await registry.register({ id: "first", plugin: plugin([source, tool("case", "Read"), message]) });
    asTool(source).resolve = () => { throw new Error("mutated"); };
    if (message.target === "custom-message") message.customType = "changed";
    await registry.register({ id: "last", plugin: { ...plugin(), requires: [transcriptRenderingCapabilityToken], activate: () => ({ contributions: { transcriptRenderers: [tool(), custom("loser"), custom("distinct", "Notice")] }, start: ({ capabilities }) => { resolved(capabilities.resolve(transcriptRenderingCapabilityToken)); } }) } });
    expect(resolved).toHaveBeenCalledWith(transcriptRenderingCapability);
    const selected = registry.getTranscriptRenderers("local");
    expect(selected.map(({ id }) => id)).toEqual(["first:tool", "first:case", "first:message", "last:tool", "last:distinct"]);
    expect(resolveTranscriptToolRenderer("read", selected)?.render(input())).toBeDefined();
    expect(resolveTranscriptToolRenderer("Read", selected)?.render(input())).toBeDefined();
    expect(resolveTranscriptToolRenderer("READ", selected)).toBeUndefined();
    expect(registry.getTranscriptRenderers("local")).toBe(selected);
    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected[0])).toBe(true);
    await registry.dispose();
    expect(registry.getTranscriptRenderers("local")).toEqual([]);
  });

  it("orders by discovery rather than asynchronous startup completion", async () => {
    const registry = new PluginRegistry();
    const gate = { pluginId: "provider", id: "ready", version: 1, parse: (value: unknown) => value };
    const result = await registry.registerBatch([
      { id: "consumer", plugin: { ...plugin([tool(), custom("message")]), requires: [gate] } },
      { id: "provider", plugin: { ...plugin(), activate: () => ({ contributions: { transcriptRenderers: [tool(), custom("message")] }, provides: [{ capability: gate, value: {} }] }) } },
    ]);
    expect(result.failures).toEqual([]);
    expect(registry.getTranscriptRenderers("local").map(({ id }) => id)).toEqual(["consumer:tool", "consumer:message", "provider:tool"]);
    await registry.dispose();
  });

  it("uses effective-machine eligibility and enablement without changing unrelated views", async () => {
    let enabled = true;
    const registry = new PluginRegistry({ isContributionEnabled: () => enabled });
    const before = registry.getTranscriptRenderers("other");
    await registry.register({ id: "remote", machineId: "remote", plugin: plugin() });
    expect(registry.getTranscriptRenderers("other")).toBe(before);
    const remote = registry.getTranscriptRenderers("remote");
    expect(remote).toHaveLength(1);
    expect(registry.getTranscriptRenderers("remote")).toBe(remote);
    enabled = false;
    expect(registry.getTranscriptRenderers("remote")).toEqual([]);
    enabled = true;
    expect(registry.getTranscriptRenderers("remote")).toEqual(remote);
    await registry.dispose();
  });

  it("rejects v4 attempts, invalid callbacks/targets and duplicate IDs, and rolls back failed starts", async () => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "v4", plugin: { apiVersion: 4, name: "Legacy", activate: () => ({ contributions: { transcriptRenderers: [] } }) } })).rejects.toThrow("require browser API v5");
    await expect(registry.register({ id: "invalid", plugin: plugin([custom("message", " ")]) })).rejects.toThrow("non-empty");
    const malformed = tool();
    Reflect.set(malformed, "resolve", undefined);
    await expect(registry.register({ id: "callback", plugin: plugin([malformed]) })).rejects.toThrow("resolve callback");
    await expect(registry.register({ id: "duplicate", plugin: plugin([tool(), tool()]) })).rejects.toThrow("Duplicate contribution id");
    await expect(registry.register({ id: "failed", plugin: { ...plugin(), activate: () => ({ contributions: { transcriptRenderers: [tool(), custom("message")] }, start: () => { throw new Error("failed start"); } }) } })).rejects.toThrow("failed start");
    expect(registry.getTranscriptRenderers("local")).toEqual([]);
    await registry.dispose();
  });

  it("aborts retained renders and next callbacks on unload and suppresses obsolete failures", async () => {
    const registry = new PluginRegistry();
    let retained: TranscriptToolRendererInput | undefined;
    let retainedNext: (() => TranscriptToolRenderer | undefined) | undefined;
    const render = vi.fn((value: TranscriptToolRendererInput) => { retained = value; return html`result`; });
    await registry.register({ id: "owner", plugin: plugin([{ id: "tool", target: "tool", resolve: (_name, next) => { retainedNext = next; return { render }; } }]) });
    const contribution = asTool(registry.getTranscriptRenderers("local")[0]);
    const downstream = vi.fn(() => undefined);
    const renderer = contribution.resolve("read", downstream);
    const value = input();
    renderer?.render(value);
    retained?.fail("live");
    expect(value.fail).toHaveBeenCalledExactlyOnceWith("live");
    await registry.dispose();
    expect(retained?.signal.aborted).toBe(true);
    retained?.fail("late");
    expect(value.fail).toHaveBeenCalledTimes(1);
    expect(renderer?.render(value)).toBeUndefined();
    expect(render).toHaveBeenCalledTimes(1);
    expect(retainedNext?.()).toBeUndefined();
    expect(contribution.resolve("read", downstream)).toBeUndefined();
    expect(downstream).not.toHaveBeenCalled();
  });
});

it("preserves undefined opt-out, snapshots returned render callbacks and suppresses failure after entry cancellation", () => {
  const controller = new AbortController();
  let retained: TranscriptToolRendererInput | undefined;
  const source = { render: (value: TranscriptToolRendererInput) => { retained = value; return undefined; } };
  const contribution = asTool(snapshotTranscriptRenderer({ id: "tool", target: "tool", resolve: () => source }, new AbortController().signal));
  const renderer = contribution.resolve("read", () => undefined);
  source.render = () => { throw new Error("mutated"); };
  const value = { ...input(), signal: controller.signal };
  expect(renderer?.render(value)).toBeUndefined();
  controller.abort();
  retained?.fail("obsolete");
  expect(retained?.signal.aborted).toBe(true);
  expect(value.fail).not.toHaveBeenCalled();
});

it("propagates both wrapper and delegated plugin lifetimes through rendered inputs", () => {
  const outerLifetime = new AbortController();
  const innerLifetime = new AbortController();
  let retained: TranscriptToolRendererInput | undefined;
  const inner = asTool(snapshotTranscriptRenderer({ id: "inner", target: "tool", resolve: () => ({ render: (value) => { retained = value; return html`inner`; } }) }, innerLifetime.signal));
  const outer = asTool(snapshotTranscriptRenderer({ id: "outer", target: "tool", resolve: (_name, next) => {
    const delegated = next();
    return { render: (value) => html`outer ${delegated?.render(value)}` };
  } }, outerLifetime.signal));
  const value = input();
  const renderer = outer.resolve("read", () => inner.resolve("read", () => undefined));
  renderer?.render(value);
  outerLifetime.abort();
  expect(retained?.signal.aborted).toBe(true);
  retained?.fail("late");
  expect(value.fail).not.toHaveBeenCalled();
  expect(renderer?.render(value)).toBeUndefined();
});

it.each([() => "not a template", () => Promise.reject(new Error("invalid async render"))])("rejects invalid inner renders before an outer template can hide them", async (result) => {
  // @ts-expect-error Exercise untyped plugin render results.
  const render: TranscriptToolRenderer["render"] = result;
  const inner = asTool(snapshotTranscriptRenderer({ id: "inner", target: "tool", resolve: () => ({ render }) }, new AbortController().signal));
  const outer = asTool(snapshotTranscriptRenderer({ id: "outer", target: "tool", resolve: (_name, next) => {
    const delegated = next();
    return { render: (value) => html`outer ${delegated?.render(value)}` };
  } }, new AbortController().signal));
  const renderer = outer.resolve("read", () => inner.resolve("read", () => undefined));
  expect(() => renderer?.render(input())).toThrow("inner must return a Lit template or undefined synchronously");
  await Promise.resolve();
});

it.each([null, false, "renderer", {}, { render: true }])("rejects invalid resolver result %j", (result) => {
  // @ts-expect-error Exercise invalid untyped plugin results at the runtime boundary.
  const resolve: TranscriptToolRendererResolver = () => result;
  const renderer = asTool(snapshotTranscriptRenderer({ id: "tool", target: "tool", resolve }, new AbortController().signal));
  expect(() => renderer.resolve("read", () => undefined)).toThrow("render callback or undefined");
});

it("rejects and consumes rejected asynchronous resolutions", async () => {
  // @ts-expect-error Async resolvers are invalid even when an untyped plugin supplies one.
  const resolve: TranscriptToolRendererResolver = () => Promise.reject(new Error("async failure"));
  const renderer = asTool(snapshotTranscriptRenderer({ id: "tool", target: "tool", resolve }, new AbortController().signal));
  expect(() => renderer.resolve("read", () => undefined)).toThrow("return synchronously");
  // Vitest reports unhandled rejections; flushing lets the consumption settle within this test.
  await Promise.resolve();
});
