import type { AuthProviderOption, AuthProviderStatus, AuthType } from "../../shared/apiTypes.js";

const OAUTH_ONLY_PROVIDERS = new Set(["github-copilot", "openai-codex"]);

export interface AuthProviderModelRegistry {
  authStorage: {
    getOAuthProviders(): { id: string; name: string }[];
    list(): string[];
    get(provider: string): { type: AuthType } | undefined;
  };
  getAll(): { provider: string }[];
  getProviderDisplayName(provider: string): string;
  getProviderAuthStatus(provider: string): AuthProviderStatus;
}

export function getLoginProviderOptions(modelRegistry: AuthProviderModelRegistry, authType?: AuthType): AuthProviderOption[] {
  const oauthProviders = modelRegistry.authStorage.getOAuthProviders();
  const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
  const options: AuthProviderOption[] = oauthProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    authType: "oauth",
    status: modelRegistry.getProviderAuthStatus(provider.id),
  }));

  const modelProviders = new Set(modelRegistry.getAll().map((model) => model.provider));
  for (const providerId of modelProviders) {
    if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) continue;
    options.push({
      id: providerId,
      name: modelRegistry.getProviderDisplayName(providerId),
      authType: "api_key",
      status: modelRegistry.getProviderAuthStatus(providerId),
    });
  }

  return filterAndSort(options, authType);
}

export function getLogoutProviderOptions(modelRegistry: AuthProviderModelRegistry): AuthProviderOption[] {
  const options: AuthProviderOption[] = [];
  for (const providerId of modelRegistry.authStorage.list()) {
    const credential = modelRegistry.authStorage.get(providerId);
    if (credential === undefined) continue;
    options.push({
      id: providerId,
      name: modelRegistry.getProviderDisplayName(providerId),
      authType: credential.type,
      status: modelRegistry.getProviderAuthStatus(providerId),
    });
  }
  return filterAndSort(options);
}

export function isApiKeyLoginProvider(providerId: string, oauthProviderIds: ReadonlySet<string>): boolean {
  if (OAUTH_ONLY_PROVIDERS.has(providerId)) return false;
  if (providerId === "anthropic") return true;
  if (oauthProviderIds.has(providerId)) return false;
  return true;
}

function filterAndSort(options: AuthProviderOption[], authType?: AuthType): AuthProviderOption[] {
  const filtered = authType === undefined ? options : options.filter((option) => option.authType === authType);
  return filtered.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType) || a.id.localeCompare(b.id));
}
