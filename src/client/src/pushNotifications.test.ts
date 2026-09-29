import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { vapidKeyFromBase64Url } from "./pushNotifications.js";

const originalAtob = globalThis.atob;

afterEach(() => {
  // The platform always provides atob in this environment; unconditional restore keeps the fakes hermetic.
  Object.defineProperty(globalThis, "atob", { value: originalAtob, configurable: true, writable: true });
});

describe("vapidKeyFromBase64Url", () => {
  it("decodes every padding shape round-trip against the platform base64url encoder", () => {
    for (const byteLength of [1, 2, 3, 4, 5, 64]) {
      const bytes = new Uint8Array(byteLength).map((_, index) => (index * 37 + 11) % 256);
      const encoded = Buffer.from(bytes).toString("base64url"); // includes -/_ characters in many cases, never padding
      expect(vapidKeyFromBase64Url(encoded)).toEqual(bytes);
    }
  });

  it("accepts legacy base64 and padded input too", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    expect(vapidKeyFromBase64Url(Buffer.from(bytes).toString("base64"))).toEqual(bytes);
    // Same payload but in url-safe alphabet without padding.
    expect(vapidKeyFromBase64Url("-_78")).toEqual(new Uint8Array([0xfb, 0xfe, 0xfc]));
  });

  it("throws a descriptive error where base64 decoding is unavailable", () => {
    Reflect.deleteProperty(globalThis, "atob");
    expect(() => vapidKeyFromBase64Url("-_78")).toThrow("Base64 decoding is unavailable in this environment");
  });
});
