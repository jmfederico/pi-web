import { describe, expect, it } from "vitest";
import { CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH, clientSessionFirstMessagePreview } from "./clientSessionPreview.js";

describe("clientSessionFirstMessagePreview", () => {
  it("preserves messages at or below the response limit", () => {
    const value = "x".repeat(CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH);

    expect(clientSessionFirstMessagePreview(value)).toBe(value);
  });

  it("bounds oversized session-list messages and marks the preview", () => {
    const preview = clientSessionFirstMessagePreview("x".repeat(253_702));

    expect(preview).toHaveLength(CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("does not split a UTF-16 surrogate pair at the preview boundary", () => {
    const prefix = "x".repeat(CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH - 4);

    expect(clientSessionFirstMessagePreview(`${prefix}😀tail`)).toBe(`${prefix}...`);
  });
});
