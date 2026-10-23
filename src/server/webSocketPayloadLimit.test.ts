import { describe, expect, it } from "vitest";
import { createSocketPayloadLimiter } from "./webSocketPayloadLimit.js";

describe("socket payload limit adapters", () => {
  it("tightens ws receiver limits when the receiver API is available", () => {
    const receiver = { _maxPayload: 1024 };
    createSocketPayloadLimiter(false)({ _receiver: receiver }, 128);
    expect(receiver._maxPayload).toBe(128);
  });

  it("allows Bun native sockets without depending on an internal class name", () => {
    expect(() => { createSocketPayloadLimiter(true)({}, 128); }).not.toThrow();
  });

  it("reports when Node receiver controls are unavailable or cannot be changed", () => {
    expect(() => { createSocketPayloadLimiter(false)({}, 128); }).toThrow("cannot apply");
    expect(() => { createSocketPayloadLimiter(false)({ _receiver: Object.freeze({ _maxPayload: 1024 }) }, 128); }).toThrow("cannot apply");
  });
});
