import { describe, expect, it } from "vitest";
import { hashSource } from "./reviewHash";

describe("hashSource", () => {
  it("is stable for the same input", () => {
    expect(hashSource("hello world")).toBe(hashSource("hello world"));
  });

  it("differs for different content", () => {
    expect(hashSource("a")).not.toBe(hashSource("b"));
  });

  it("is order-sensitive", () => {
    expect(hashSource("ab")).not.toBe(hashSource("ba"));
  });

  it("handles empty input", () => {
    expect(hashSource("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces an 8-char hex string", () => {
    expect(hashSource("some longer source text\nwith newlines")).toMatch(/^[0-9a-f]{8}$/);
  });
});
