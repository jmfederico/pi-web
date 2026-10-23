import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePiWebRuntimeIdentity, piWebRuntimeIdentity } from "./piWebRuntime.js";

afterEach(() => { vi.unstubAllEnvs(); });

describe("runtime identity", () => {
  it("uses process facts, not the launcher preference or Bun globals", () => {
    vi.stubEnv("PI_WEB_RUNTIME", "bun");
    expect(piWebRuntimeIdentity({ node: "22.0.0" })).toEqual({ name: "node", version: "22.0.0" });
    vi.stubEnv("PI_WEB_RUNTIME", "node");
    expect(piWebRuntimeIdentity({ node: "24.0.0", bun: "1.3.0" })).toEqual({ name: "bun", version: "1.3.0" });
    expect(piWebRuntimeIdentity()).toEqual(process.versions["bun"] === undefined
      ? { name: "node", version: process.versions.node }
      : { name: "bun", version: process.versions["bun"] });
  });

  it("ignores absent, malformed and future optional engine metadata", () => {
    for (const value of [undefined, null, {}, "bun", { name: "deno", version: "2" }, { name: "bun", version: "" }]) {
      expect(parsePiWebRuntimeIdentity(value)).toBeUndefined();
    }
    expect(parsePiWebRuntimeIdentity({ name: "bun", version: "1.3.0", future: true }))
      .toEqual({ name: "bun", version: "1.3.0" });
  });
});
