import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AgentSessionRuntimeDiagnostic, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent";
import { anthropicSubscriptionWarning, collectRuntimeWarnings, dismissSessionWarning, type RuntimeWarningSources } from "./piSessionService.js";
import { testModel } from "./piSessionService.testSupport.js";
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

type SubscriptionSession = Pick<PiAgentSession, "model" | "settingsManager">;

function anthropicModel(provider: string): PiAgentSession["model"] {
  // anthropicSubscriptionWarning only reads `model.provider`, so any built-in
  // model re-tagged with the desired provider is a sufficient fixture.
  return { ...testModel(), provider };
}

function subscriptionSession(options: {
  provider?: string;
  anthropicExtraUsage?: boolean;
}): SubscriptionSession {
  return {
    model: options.provider === undefined ? undefined : anthropicModel(options.provider),
    settingsManager: {
      getWarnings: () => (options.anthropicExtraUsage === undefined ? {} : { anthropicExtraUsage: options.anthropicExtraUsage }),
      setWarnings: () => undefined,
    },
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Write an `auth.json` holding a single anthropic credential and return its
 * path. `anthropicSubscriptionWarning` reads it via `readStoredCredential`, so
 * the credential seam is the on-disk auth file rather than an in-memory store.
 */
async function anthropicAuthPath(credential: { type: "oauth" } | { type: "api_key"; key: string }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-warnings-"));
  tempDirs.push(dir);
  const authPath = join(dir, "auth.json");
  const stored = credential.type === "oauth"
    ? { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }
    : { type: "api_key", key: credential.key };
  await writeFile(authPath, JSON.stringify({ anthropic: stored }));
  return authPath;
}

describe("anthropicSubscriptionWarning", () => {
  it("warns with the verbatim SDK wording for a stored oauth credential", async () => {
    expect(anthropicSubscriptionWarning(
      subscriptionSession({ provider: "anthropic" }),
      await anthropicAuthPath({ type: "oauth" }),
    )).toEqual({
      severity: "warning",
      message: ANTHROPIC_SUBSCRIPTION_AUTH_WARNING,
      source: "anthropic",
      dismiss: { id: "anthropicExtraUsage" },
    } satisfies SessionWarning);
  });

  it("warns for an sk-ant-oat subscription API key", async () => {
    expect(anthropicSubscriptionWarning(
      subscriptionSession({ provider: "anthropic" }),
      await anthropicAuthPath({ type: "api_key", key: "sk-ant-oat-abc123" }),
    )?.message).toBe(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
  });

  it("does not warn for a standard anthropic API key", async () => {
    expect(anthropicSubscriptionWarning(
      subscriptionSession({ provider: "anthropic" }),
      await anthropicAuthPath({ type: "api_key", key: "sk-ant-api-abc123" }),
    )).toBeUndefined();
  });

  it("respects the anthropicExtraUsage suppression gate", async () => {
    expect(anthropicSubscriptionWarning(
      subscriptionSession({ provider: "anthropic", anthropicExtraUsage: false }),
      await anthropicAuthPath({ type: "oauth" }),
    )).toBeUndefined();
  });

  it("does not warn when the active provider is not anthropic", async () => {
    expect(anthropicSubscriptionWarning(
      subscriptionSession({ provider: "openai" }),
      await anthropicAuthPath({ type: "oauth" }),
    )).toBeUndefined();
  });

  it("does not warn when no anthropic credential is stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-warnings-"));
    tempDirs.push(dir);
    expect(anthropicSubscriptionWarning(
      subscriptionSession({ provider: "anthropic" }),
      join(dir, "auth.json"),
    )).toBeUndefined();
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
