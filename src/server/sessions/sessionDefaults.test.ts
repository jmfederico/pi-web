import { describe, expect, it } from "vitest";
import { parseSessionDefaults, parseSessionDefaultsUpdate } from "../../shared/sessionDefaults.js";
import { KNOWN_THINKING_LEVELS } from "../../shared/thinkingLevels.js";
import { FEDERATED_HTTP_ROUTES } from "../../shared/federatedRoutes.js";

describe("session defaults wire contract", () => {
  it("accepts missing defaults and all known thinking levels", () => {
    expect(parseSessionDefaults({})).toEqual({});
    for (const level of KNOWN_THINKING_LEVELS) {
      expect(parseSessionDefaults({ defaultThinkingLevel: level })).toEqual({ defaultThinkingLevel: level });
      expect(parseSessionDefaultsUpdate({ thinkingLevel: level })).toEqual({ thinkingLevel: level });
    }
    expect(parseSessionDefaults({ defaultProvider: "p", defaultModel: "m", unrelated: true })).toEqual({ defaultProvider: "p", defaultModel: "m" });
  });

  it("rejects malformed responses", () => {
    for (const value of [null, [], "defaults", { defaultModel: 42 }, { defaultProvider: null }, { defaultThinkingLevel: "unknown" }]) {
      expect(() => parseSessionDefaults(value)).toThrow();
    }
  });

  it("allows both defaults endpoints through federation", () => {
    for (const method of ["GET", "POST"]) {
      expect(FEDERATED_HTTP_ROUTES).toEqual(expect.arrayContaining([expect.objectContaining({ method, path: "/sessions/:sessionId/defaults" })]));
    }
  });
});
