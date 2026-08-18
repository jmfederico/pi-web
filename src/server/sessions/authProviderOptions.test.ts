import { describe, expect, it } from "vitest";
import { getLoginProviderOptions, getLogoutProviderOptions, type AuthProviderRuntime } from "./authProviderOptions";

function runtime(configuredProviders: ReadonlySet<string> = new Set(["openai"])): AuthProviderRuntime {
  const credentials = [{ providerId: "openai", type: "api_key" as const }];
  // Auth shapes mirror what the Pi SDK actually reports for these providers:
  // github-copilot supports both methods, openai-codex is OAuth-only, and
  // ambient providers resolve credentials without offering interactive login.
  const providers = [
    { id: "anthropic", name: "Anthropic", auth: { oauth: {}, apiKey: { login: () => undefined } } },
    { id: "github-copilot", name: "GitHub Copilot", auth: { oauth: {}, apiKey: { login: () => undefined } } },
    { id: "openai-codex", name: "ChatGPT Plus/Pro (Codex Subscription)", auth: { oauth: {} } },
    { id: "openai", name: "OpenAI", auth: { apiKey: { login: () => undefined } } },
    { id: "custom", name: "Custom", auth: { apiKey: { login: () => undefined } } },
    { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", auth: { apiKey: { login: () => undefined } } },
    { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", auth: { apiKey: { login: () => undefined } } },
    { id: "amazon-bedrock", name: "Amazon Bedrock", auth: { apiKey: { login: () => undefined } } },
    { id: "google-vertex", name: "Google Vertex AI", auth: { apiKey: { login: () => undefined } } },
    { id: "ambient", name: "Ambient credentials", auth: { apiKey: {} } },
  ];
  return {
    getProviders: () => providers,
    listCredentials: () => Promise.resolve(credentials),
    getProviderAuthStatus: (provider: string) => (provider === "openai" ? { configured: true, source: "stored" } : { configured: false }),
    hasConfiguredAuth: (provider: string) => configuredProviders.has(provider),
  };
}

describe("auth provider options", () => {
  it("offers each interactive login method reported by the backend", () => {
    const options = getLoginProviderOptions(runtime());
    expect(options).toEqual(expect.arrayContaining([
      // Dual-capable providers surface both login methods, driven purely by SDK data.
      expect.objectContaining({ id: "anthropic", authType: "oauth" }),
      expect.objectContaining({ id: "anthropic", authType: "api_key" }),
      expect.objectContaining({ id: "github-copilot", authType: "oauth" }),
      expect.objectContaining({ id: "github-copilot", authType: "api_key" }),
      // OAuth-only provider surfaces only oauth.
      expect.objectContaining({ id: "openai-codex", authType: "oauth" }),
      // API-key options use the generic AuthInteraction flow, including
      // multi-field and select-first providers the legacy form cannot execute.
      expect.objectContaining({ id: "openai", authType: "api_key", loginFlow: "interactive", status: { configured: true, source: "stored" } }),
      expect.objectContaining({ id: "custom", authType: "api_key", loginFlow: "interactive" }),
      expect.objectContaining({ id: "cloudflare-ai-gateway", authType: "api_key", loginFlow: "interactive" }),
      expect.objectContaining({ id: "cloudflare-workers-ai", authType: "api_key", loginFlow: "interactive" }),
      expect.objectContaining({ id: "amazon-bedrock", authType: "api_key", loginFlow: "interactive" }),
      expect.objectContaining({ id: "google-vertex", authType: "api_key", loginFlow: "interactive" }),
    ]));
    expect(options).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "openai-codex", authType: "api_key" })]));
    expect(options).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "openai", authType: "oauth" })]));
    expect(options).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "ambient", authType: "api_key" })]));
  });

  it("does not report a stored credential as configured when provider resolution is incomplete", async () => {
    const unresolvedRuntime = runtime(new Set());

    expect(getLoginProviderOptions(unresolvedRuntime, "api_key")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "openai", status: { configured: false } }),
    ]));
    expect(await getLogoutProviderOptions(unresolvedRuntime)).toEqual([
      expect.objectContaining({ id: "openai", authType: "api_key", status: { configured: false } }),
    ]);
  });

  it("returns only currently stored credentials for logout", async () => {
    expect(await getLogoutProviderOptions(runtime())).toEqual([
      expect.objectContaining({ id: "openai", authType: "api_key", status: { configured: true, source: "stored" } }),
    ]);
  });
});
