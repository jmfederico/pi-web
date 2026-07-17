import type { AuthProviderOption, AuthProviderStatus, AuthType } from "../../shared/apiTypes.js";

interface AuthProviderDefinition {
  id: string;
  name: string;
  auth: {
    apiKey?: { login?: unknown };
    oauth?: unknown;
  };
}

export interface AuthProviderModelRuntime {
  getProviders(): readonly AuthProviderDefinition[];
  getProvider(providerId: string): AuthProviderDefinition | undefined;
  listCredentials(): Promise<readonly { providerId: string; type: AuthType }[]>;
  getProviderAuthStatus(providerId: string): AuthProviderStatus;
}

export function getLoginProviderOptions(modelRuntime: AuthProviderModelRuntime, authType?: AuthType): AuthProviderOption[] {
  const options: AuthProviderOption[] = [];
  for (const provider of modelRuntime.getProviders()) {
    if (provider.auth.oauth !== undefined) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "oauth",
        status: modelRuntime.getProviderAuthStatus(provider.id),
      });
    }
    if (provider.auth.apiKey?.login !== undefined) {
      options.push({
        id: provider.id,
        name: provider.name,
        authType: "api_key",
        status: modelRuntime.getProviderAuthStatus(provider.id),
      });
    }
  }
  return filterAndSort(options, authType);
}

export async function getLogoutProviderOptions(modelRuntime: AuthProviderModelRuntime): Promise<AuthProviderOption[]> {
  const options: AuthProviderOption[] = [];
  for (const credential of await modelRuntime.listCredentials()) {
    const provider = modelRuntime.getProvider(credential.providerId);
    options.push({
      id: credential.providerId,
      name: provider?.name ?? credential.providerId,
      authType: credential.type,
      status: modelRuntime.getProviderAuthStatus(credential.providerId),
    });
  }
  return filterAndSort(options);
}

function filterAndSort(options: AuthProviderOption[], authType?: AuthType): AuthProviderOption[] {
  const filtered = authType === undefined ? options : options.filter((option) => option.authType === authType);
  return filtered.sort((a, b) => a.name.localeCompare(b.name) || a.authType.localeCompare(b.authType) || a.id.localeCompare(b.id));
}
