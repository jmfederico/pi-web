import { describe, expect, it } from "vitest";
import { readSessionUiMetadata, requireSessionUiMetadata, SESSION_UI_METADATA_CUSTOM_TYPE, SESSION_UI_METADATA_MAX_BYTES, sessionUiMetadataFromEntry } from "./sessionMetadata.js";

function entry(metadata: unknown, version = 1) {
  return { type: "custom", customType: SESSION_UI_METADATA_CUSTOM_TYPE, data: { version, metadata } };
}

describe("session UI metadata boundary", () => {
  it("detaches and freezes namespaced JSON, including safe copies of special object keys", () => {
    const input = { "@example/package": { identity: { leg: 2 }, flags: [true, null] } };
    const result = requireSessionUiMetadata(input);
    input["@example/package"].identity.leg = 3;
    expect(result).toEqual({ "@example/package": { identity: { leg: 2 }, flags: [true, null] } });
    expect(Object.isFrozen(result["@example/package"])).toBe(true);
    const special: unknown = JSON.parse('{"example":{"__proto__":{"public":true}}}');
    expect(JSON.stringify(requireSessionUiMetadata(special))).toBe('{"example":{"__proto__":{"public":true}}}');
    expect(Reflect.get(Object.prototype, "public")).toBeUndefined();
  });

  it.each([
    null, [], "text", { "": {} }, { "bad namespace": {} }, { example: [] }, { example: null },
    { example: 1 }, { example: { secret: undefined } }, { example: { invalid: Number.NaN } },
    { example: { invalid: new Date() } }, { example: { invalid: () => undefined } },
  ])("rejects non-JSON or non-namespaced input %j", (input) => {
    expect(() => requireSessionUiMetadata(input)).toThrow();
  });

  it("rejects cyclic, excessively deep and oversized public data", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["cycle"] = cyclic;
    expect(() => requireSessionUiMetadata({ example: cyclic })).toThrow("cycles");
    let deep: unknown = {};
    for (let i = 0; i < 66; i++) deep = { child: deep };
    expect(() => requireSessionUiMetadata({ example: deep })).toThrow("depth");
    expect(() => requireSessionUiMetadata({ example: { text: "é".repeat(SESSION_UI_METADATA_MAX_BYTES) } })).toThrow("byte limit");
  });

  it("reads only the public custom-entry schema and ignores other data and unknown versions", () => {
    const metadata = { example: { identity: "explicit" } };
    expect(sessionUiMetadataFromEntry(entry(metadata))).toEqual(metadata);
    for (const candidate of [
      { type: "custom", customType: "private-extension", data: metadata },
      { type: "custom_message", customType: SESSION_UI_METADATA_CUSTOM_TYPE, data: { version: 1, metadata } },
      entry(metadata, 2), entry({ example: "not an object" }), entry(undefined), null,
    ]) expect(sessionUiMetadataFromEntry(candidate)).toBeUndefined();
  });

  it("folds session-wide snapshots in file order, skipping corrupt entries and allowing an explicit clear", () => {
    const original = entry({ example: { leg: 1 } });
    const latest = { ...entry({ example: { leg: 2 } }), parentId: null };
    expect(readSessionUiMetadata([original, latest, entry({ example: null })])).toEqual({ example: { leg: 2 } });
    expect(readSessionUiMetadata([original, latest, entry({})])).toEqual({});
    expect(readSessionUiMetadata([])).toBeUndefined();
  });
});
