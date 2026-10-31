import { describe, expect, it } from "vitest";
import { requireInitialSessionName } from "./sessionNameGenerator.js";

describe("requireInitialSessionName", () => {
  it("preserves explicit extension names", () => {
    expect(requireInitialSessionName("A workflow leg 2")).toBe("A workflow leg 2");
  });

  it.each([undefined, null, "", " ", " padded", "padded ", "two\nlines", "control\0character", "a".repeat(61)])("rejects invalid initial names (%j)", (value) => {
    expect(() => requireInitialSessionName(value)).toThrow("Initial session name");
  });
});
