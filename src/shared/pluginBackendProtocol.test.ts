import { describe, expect, it } from "vitest";
import {
  boundedPluginBackendChannelCloseReason,
  cloneBoundedPluginBackendJson,
  parseBoundedPluginBackendJson,
  parsePluginBackendChannelClientEnvelope,
  parsePluginBackendChannelServerEnvelope,
  PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES,
  PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES,
  PLUGIN_BACKEND_JSON_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  serializeBoundedPluginBackendJson,
  serializePluginBackendChannelDataEnvelope,
  serializePluginBackendChannelErrorEnvelope,
  serializePluginBackendChannelOpenEnvelope,
  serializePluginBackendChannelReadyEnvelope,
} from "./pluginBackendProtocol.js";

describe("plugin backend JSON contract", () => {
  it("round-trips __proto__ as an own JSON key without mutating object prototypes", () => {
    const input: unknown = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":"value"}}');

    const cloned = cloneBoundedPluginBackendJson(input, "fixture");
    const serialized = serializeBoundedPluginBackendJson(cloned, "fixture");
    const parsed = parseBoundedPluginBackendJson(serialized, "fixture");

    expect(Object.hasOwn(requireRecord(cloned), "__proto__")).toBe(true);
    expect(Object.hasOwn(requireRecord(requireRecord(cloned)["nested"]), "__proto__")).toBe(true);
    expect(JSON.parse(serialized)).toEqual(JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":"value"}}'));
    expect(parsed).toEqual(cloned);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("enforces the exact serialized UTF-8 byte boundary", () => {
    const exact = "x".repeat(PLUGIN_BACKEND_JSON_MAX_BYTES - 2);
    expect(cloneBoundedPluginBackendJson(exact, "fixture")).toBe(exact);
    expect(() => cloneBoundedPluginBackendJson(`${exact}x`, "fixture")).toThrow("byte limit");
  });

  it("keeps requests small while allowing the larger bounded result Git demonstrates", () => {
    const result = "x".repeat(PLUGIN_BACKEND_JSON_MAX_BYTES);

    expect(() => cloneBoundedPluginBackendJson(result, "request")).toThrow("byte limit");
    expect(cloneBoundedPluginBackendJson(result, "result", PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES)).toBe(result);
    expect(parseBoundedPluginBackendJson(JSON.stringify(result), "result", PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES)).toBe(result);
  });

  it("round-trips versioned channel host envelopes without interpreting plugin data", () => {
    const open = serializePluginBackendChannelOpenEnvelope("server-r1", { type: "terminal.private", nested: [1, true] });
    const data = serializePluginBackendChannelDataEnvelope({ frame: "opaque" });

    expect(parsePluginBackendChannelClientEnvelope(open)).toEqual({
      version: 1,
      kind: "open",
      revision: "server-r1",
      input: { type: "terminal.private", nested: [1, true] },
    });
    expect(parsePluginBackendChannelClientEnvelope(data)).toEqual({ version: 1, kind: "data", data: { frame: "opaque" } });
    expect(parsePluginBackendChannelServerEnvelope(serializePluginBackendChannelReadyEnvelope())).toEqual({ version: 1, kind: "ready" });
    expect(parsePluginBackendChannelServerEnvelope(serializePluginBackendChannelErrorEnvelope("open-failed", "No channel"))).toEqual({
      version: 1,
      kind: "error",
      code: "open-failed",
      message: "No channel",
    });
  });

  it("bounds channel payloads, envelope direction, and UTF-8 close reasons", () => {
    const exactData = "x".repeat(PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES - 2);
    expect(() => serializePluginBackendChannelDataEnvelope(exactData)).not.toThrow();
    expect(() => serializePluginBackendChannelDataEnvelope(`${exactData}x`)).toThrow("byte limit");
    expect(() => parsePluginBackendChannelClientEnvelope('{"version":1,"kind":"ready"}')).toThrow("kind is invalid");
    expect(() => parsePluginBackendChannelServerEnvelope('{"version":2,"kind":"ready"}')).toThrow("version is unsupported");

    const bounded = boundedPluginBackendChannelCloseReason("🙂".repeat(100));
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(PLUGIN_BACKEND_CHANNEL_CLOSE_REASON_MAX_BYTES);
    expect(bounded.endsWith("🙂")).toBe(true);
  });

  it("rejects inherited and non-JSON runtime objects rather than serializing them ambiguously", () => {
    class RuntimeValue {
      readonly value = "hidden";
    }

    expect(() => cloneBoundedPluginBackendJson(new RuntimeValue(), "fixture")).toThrow("only JSON values");
    expect(() => cloneBoundedPluginBackendJson(Object.assign(Object.create({ inherited: true }), { own: true }), "fixture"))
      .toThrow("only JSON values");
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(() => cloneBoundedPluginBackendJson(cycle, "fixture")).toThrow("cycles");
  });
});

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected record");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
