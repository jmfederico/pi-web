import { describe, expect, it } from "vitest";
import { AuthStorage, ModelRegistry, type AgentSessionRuntimeDiagnostic, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { anthropicSubscriptionWarning, collectRuntimeWarnings, dismissSessionWarning, type RuntimeWarningSources } from "./piSessionService.js";
import type { PiAgentSession } from "./piSessionService.js";
import type { SessionWarning } from "../../shared/apiTypes.js";

function runtimeWith(options: {
  diagnostics?: readonly AgentSessionRuntimeDiagnostic[];
  skills?: readonly ResourceDiagnostic[];
  prompts?: readonly ResourceDiagnostic[];
  themes?: readonly ResourceDiagnostic[];
  extensionErrors?: readonly { path: string; error: string }[];
  withServices?: boolean;
}): RuntimeWarningSources {
  const services: NonNullable<RuntimeWarningSources["services"]> = {
    resourceLoader: {
      getSkills: () => ({ diagnostics: options.skills ?? [] }),
      getPrompts: () => ({ diagnostics: options.prompts ?? [] }),
      getThemes: () => ({ diagnostics: options.themes ?? [] }),
      getExtensions: () => ({ errors: options.extensionErrors ?? [] }),
    },
  };
  return {
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.withServices === false ? {} : { services }),
  };
}

describe("collectRuntimeWarnings", () => {
  it("returns no warnings for a runtime without SDK services", () => {
    expect(collectRuntimeWarnings({})).toEqual([]);
  });

  it("maps runtime diagnostics preserving severity and tagging the runtime source", () => {
    const diagnostics: AgentSessionRuntimeDiagnostic[] = [
      { type: "warning", message: "runtime warned" },
      { type: "error", message: "runtime failed" },
      { type: "info", message: "runtime noted" },
    ];

    expect(collectRuntimeWarnings(runtimeWith({ diagnostics, withServices: false }))).toEqual([
      { severity: "warning", message: "runtime warned", source: "runtime" },
      { severity: "error", message: "runtime failed", source: "runtime" },
      { severity: "info", message: "runtime noted", source: "runtime" },
    ] satisfies SessionWarning[]);
  });

  it("maps resource diagnostics to their source labels and carries an optional path", () => {
    const warnings = collectRuntimeWarnings(runtimeWith({
      skills: [{ type: "error", message: "bad skill", path: "/skills/a.md" }],
      prompts: [{ type: "warning", message: "odd prompt" }],
      themes: [{ type: "warning", message: "odd theme" }],
    }));

    expect(warnings).toEqual([
      { severity: "error", message: "bad skill", source: "skill", path: "/skills/a.md" },
      { severity: "warning", message: "odd prompt", source: "prompt" },
      { severity: "warning", message: "odd theme", source: "theme" },
    ] satisfies SessionWarning[]);
  });

  it("treats non-error resource diagnostics as warning severity", () => {
    const [warning] = collectRuntimeWarnings(runtimeWith({ skills: [{ type: "warning", message: "hmm" }] }));
    expect(warning?.severity).toBe("warning");
  });

  it("surfaces extension load errors with the failing path", () => {
    expect(collectRuntimeWarnings(runtimeWith({ extensionErrors: [{ path: "/ext/x.js", error: "boom" }] }))).toEqual([
      { severity: "error", message: "/ext/x.js: boom", source: "extension", path: "/ext/x.js" },
    ] satisfies SessionWarning[]);
  });

  it("orders runtime diagnostics before resource diagnostics", () => {
    const warnings = collectRuntimeWarnings(runtimeWith({
      diagnostics: [{ type: "warning", message: "runtime first" }],
      skills: [{ type: "error", message: "skill second" }],
    }));

    expect(warnings.map((warning) => warning.message)).toEqual(["runtime first", "skill second"]);
  });
});

const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
  "Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

type SubscriptionSession = Pick<PiAgentSession, "model" | "modelRegistry" | "settingsManager">;

function anthropicModel(provider: string): PiAgentSession["model"] {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  const model = registry.getAll().find((candidate) => candidate.provider === provider) ?? registry.getAll()[0];
  if (model === undefined) throw new Error("expected at least one built-in model");
  return { ...model, provider };
}

function subscriptionSession(options: {
  provider?: string;
  anthropicExtraUsage?: boolean;
  credential?: AuthStorage;
}): SubscriptionSession {
  const authStorage = options.credential ?? AuthStorage.inMemory();
  return {
    model: options.provider === undefined ? undefined : anthropicModel(options.provider),
    settingsManager: {
      getWarnings: () => (options.anthropicExtraUsage === undefined ? {} : { anthropicExtraUsage: options.anthropicExtraUsage }),
      setWarnings: () => undefined,
    },
    modelRegistry: ModelRegistry.create(authStorage),
  };
}

function anthropicAuth(credential: { type: "oauth" } | { type: "api_key"; key: string }): AuthStorage {
  const authStorage = AuthStorage.inMemory();
  if (credential.type === "oauth") {
    authStorage.set("anthropic", { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 });
  } else {
    authStorage.set("anthropic", { type: "api_key", key: credential.key });
  }
  return authStorage;
}

describe("anthropicSubscriptionWarning", () => {
  it("warns with the verbatim SDK wording for a stored oauth credential", () => {
    expect(anthropicSubscriptionWarning(subscriptionSession({
      provider: "anthropic",
      credential: anthropicAuth({ type: "oauth" }),
    }))).toEqual({
      severity: "warning",
      message: ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
      source: "anthropic",
      dismiss: { id: "anthropicExtraUsage" },
    } satisfies SessionWarning);
  });

  it("warns for an sk-ant-oat subscription API key", () => {
    expect(anthropicSubscriptionWarning(subscriptionSession({
      provider: "anthropic",
      credential: anthropicAuth({ type: "api_key", key: "sk-ant-oat-abc123" }),
    }))?.message).toBe(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
  });

  it("does not warn for a standard anthropic API key", () => {
    expect(anthropicSubscriptionWarning(subscriptionSession({
      provider: "anthropic",
      credential: anthropicAuth({ type: "api_key", key: "sk-ant-api-abc123" }),
    }))).toBeUndefined();
  });

  it("respects the anthropicExtraUsage suppression gate", () => {
    expect(anthropicSubscriptionWarning(subscriptionSession({
      provider: "anthropic",
      anthropicExtraUsage: false,
      credential: anthropicAuth({ type: "oauth" }),
    }))).toBeUndefined();
  });

  it("does not warn when the active provider is not anthropic", () => {
    expect(anthropicSubscriptionWarning(subscriptionSession({
      provider: "openai",
      credential: anthropicAuth({ type: "oauth" }),
    }))).toBeUndefined();
  });

  it("does not warn when no anthropic credential is stored", () => {
    expect(anthropicSubscriptionWarning(subscriptionSession({ provider: "anthropic" }))).toBeUndefined();
  });
});

describe("dismissSessionWarning", () => {
  it("durably suppresses the anthropic notice via pi's WarningSettings key", () => {
    const calls: { anthropicExtraUsage?: boolean }[] = [];
    dismissSessionWarning({
      settingsManager: {
        getWarnings: () => ({}),
        setWarnings: (warnings) => { calls.push(warnings); },
      },
    }, "anthropicExtraUsage");

    expect(calls).toEqual([{ anthropicExtraUsage: false }]);
  });

  it("preserves other warning settings when suppressing", () => {
    const calls: { anthropicExtraUsage?: boolean }[] = [];
    dismissSessionWarning({
      settingsManager: {
        getWarnings: () => ({ anthropicExtraUsage: true }),
        setWarnings: (warnings) => { calls.push(warnings); },
      },
    }, "anthropicExtraUsage");

    expect(calls).toEqual([{ anthropicExtraUsage: false }]);
  });

  it("rejects an unknown dismiss id instead of silently no-opping", () => {
    let called = false;
    expect(() => { dismissSessionWarning({
      settingsManager: {
        getWarnings: () => ({}),
        setWarnings: () => { called = true; },
      },
    }, "somethingElse"); }).toThrow("Unknown session warning dismiss id: somethingElse");
    expect(called).toBe(false);
  });
});
