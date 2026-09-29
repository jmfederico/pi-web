import { describe, expect, it } from "vitest";

// Guards against upstream Pi SDK packaging regressions such as
// @earendil-works/pi-coding-agent@0.85.0, whose barrel statically imported the
// undeclared @earendil-works/pi-server package and therefore could not be loaded
// at all (https://github.com/jmfederico/pi-web/issues/212). Imports are dynamic so
// a broken barrel fails this one test with a clear message instead of breaking
// test-file collection across the whole suite.

// pi-coding-agent 0.85.0 is the known-broken release; it is also excluded from
// the peer dependency range in package.json.
const BROKEN_PI_CODING_AGENT_VERSIONS = new Set(["0.85.0"]);

describe("Pi SDK package integrity", () => {
  it("loads the pi-coding-agent barrel with the runtime surface PI WEB uses", async () => {
    const sdk = await importSdk("@earendil-works/pi-coding-agent");

    const version = sdk["VERSION"];
    if (typeof version !== "string") {
      throw new Error("The @earendil-works/pi-coding-agent VERSION export is missing or not a string");
    }
    expect(BROKEN_PI_CODING_AGENT_VERSIONS.has(version)).toBe(false);
    for (const name of [
      "AgentSession",
      "createAgentSession",
      "CredentialSynchronizationError",
      "DefaultPackageManager",
      "DefaultResourceLoader",
      "defineTool",
      "formatDimensionNote",
      "ModelRuntime",
      "ProjectTrustStore",
      "resizeImage",
      "SessionManager",
      "SettingsManager",
      "Theme",
    ]) {
      expect(typeof sdk[name], name).toBe("function");
    }
  });

  it("loads the pi-ai barrel with the runtime surface PI WEB uses", async () => {
    const sdk = await importSdk("@earendil-works/pi-ai");

    for (const name of ["createAssistantMessageEventStream", "InMemoryCredentialStore", "modelsAreEqual"]) {
      expect(typeof sdk[name], name).toBe("function");
    }
  });

  it("loads the pi-agent-core barrel with the runtime surface PI WEB uses", async () => {
    const sdk = await importSdk("@earendil-works/pi-agent-core");

    expect(typeof sdk["runAgentLoop"], "runAgentLoop").toBe("function");
  });
});

async function importSdk(specifier: string): Promise<Record<string, unknown>> {
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    throw new Error(
      `The ${specifier} package could not be loaded. This usually means the installed Pi SDK release has a packaging defect; check the resolved version against the supported range in package.json.`,
      { cause: error },
    );
  }
  if (!isRecord(loaded)) {
    throw new Error(`The ${specifier} module did not evaluate to a module namespace object`);
  }
  return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
