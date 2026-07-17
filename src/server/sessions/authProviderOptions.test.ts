import { describe, expect, it } from "vitest";
import { getLoginProviderOptions, getLogoutProviderOptions, type AuthProviderModelRuntime } from "./authProviderOptions.js";

function runtime(): AuthProviderModelRuntime {
  const providers = [
    { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: { login: () => undefined } } },
    { id: "openai", name: "OpenAI", auth: { apiKey: { login: () => undefined } } },
    { id: "openai-codex", name: "ChatGPT Plus/Pro", auth: { oauth: {} } },
    { id: "ambient", name: "Ambient", auth: { apiKey: {} } },
  ];
  return {
    getProviders: () => providers,
    getProvider: (providerId) => providers.find((provider) => provider.id === providerId),
    listCredentials: () => Promise.resolve([{ providerId: "openai", type: "api_key" }]),
    getProviderAuthStatus: (providerId) => providerId === "openai"
      ? { configured: true, source: "stored" }
      : { configured: false },
  };
}

describe("auth provider options", () => {
  it("builds login options from provider-owned auth capabilities", () => {
    const options = getLoginProviderOptions(runtime());
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "anthropic", authType: "oauth" }),
      expect.objectContaining({ id: "anthropic", authType: "api_key" }),
      expect.objectContaining({ id: "openai", authType: "api_key", status: { configured: true, source: "stored" } }),
      expect.objectContaining({ id: "openai-codex", authType: "oauth" }),
    ]));
    expect(options).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai-codex", authType: "api_key" }),
      expect.objectContaining({ id: "ambient", authType: "api_key" }),
    ]));
  });

  it("filters login options by auth type", () => {
    expect(getLoginProviderOptions(runtime(), "oauth").every((option) => option.authType === "oauth")).toBe(true);
  });

  it("returns only currently stored credentials for logout", async () => {
    await expect(getLogoutProviderOptions(runtime())).resolves.toEqual([
      expect.objectContaining({ id: "openai", name: "OpenAI", authType: "api_key" }),
    ]);
  });
});
