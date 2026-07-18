import { describe, expect, it } from "vitest";
import { oauthPromptInputType } from "./AuthDialog";

describe("oauthPromptInputType", () => {
  it("renders additive secret prompts as password inputs and defaults legacy prompts to text", () => {
    expect(oauthPromptInputType("secret")).toBe("password");
    expect(oauthPromptInputType("text")).toBe("text");
    expect(oauthPromptInputType("manual_code")).toBe("text");
    expect(oauthPromptInputType(undefined)).toBe("text");
  });
});
