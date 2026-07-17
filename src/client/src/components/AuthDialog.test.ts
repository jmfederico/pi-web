import { describe, expect, it } from "vitest";
import { oauthPromptInputType } from "./AuthDialog";

describe("oauthPromptInputType", () => {
  it("renders secret prompts as password inputs", () => {
    expect(oauthPromptInputType("secret")).toBe("password");
    expect(oauthPromptInputType("text")).toBe("text");
    expect(oauthPromptInputType("manual-code")).toBe("text");
  });
});
