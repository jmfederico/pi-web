import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebConfigResponse, PiWebPluginInfo } from "../shared/apiTypes.js";
import type { SessionDaemonAgentProfileResult } from "../sessiond/sessionDaemonClient.js";
import type { ActiveAgentProfileProvider } from "./activeAgentProfileProvider.js";
import { buildApp } from "./app.js";
import type { PiWebConfigService } from "./configRoutes.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-active-profile-app-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildApp active profile composition", () => {
  it("routes package and package-backed plugin reads through the same refreshable provider", async () => {
    const firstAgentDir = join(tempDir, "first-agent");
    const secondAgentDir = join(tempDir, "second-agent");
    const firstPackageDir = join(tempDir, "first-package");
    const secondPackageDir = join(tempDir, "second-package");
    await Promise.all([
      writePackagePlugin(firstPackageDir, "profile-first"),
      writePackagePlugin(secondPackageDir, "profile-second"),
      writePiPackageSettings(firstAgentDir, [firstPackageDir]),
      writePiPackageSettings(secondAgentDir, [secondPackageDir]),
    ]);

    let result: SessionDaemonAgentProfileResult = { status: "available", profile: activeProfile("a", "first-agent", firstAgentDir) };
    const getActiveAgentProfile = vi.fn(() => Promise.resolve(result));
    const app = await buildApp({
      agentProfileProvider: { getActiveAgentProfile },
      config: emptyConfigService(),
      clientDist: false,
      logger: false,
    });

    try {
      const firstPackages = await app.inject({ method: "GET", url: "/api/pi-packages" });
      const firstPlugins = await app.inject({ method: "GET", url: "/api/plugins" });
      expect(firstPackages.statusCode).toBe(200);
      expect(packageSources(firstPackages.json())).toContain(firstPackageDir);
      expect(pluginIds(firstPlugins.json())).toContain("profile-first");
      expect(pluginIds(firstPlugins.json())).not.toContain("profile-second");

      result = { status: "available", profile: activeProfile("b", "second-agent", secondAgentDir) };

      const secondPackages = await app.inject({ method: "GET", url: "/api/pi-packages" });
      const secondPlugins = await app.inject({ method: "GET", url: "/api/plugins" });
      expect(secondPackages.statusCode).toBe(200);
      expect(packageSources(secondPackages.json())).toContain(secondPackageDir);
      expect(packageSources(secondPackages.json())).not.toContain(firstPackageDir);
      expect(pluginIds(secondPlugins.json())).toContain("profile-second");
      expect(pluginIds(secondPlugins.json())).not.toContain("profile-first");
      expect(getActiveAgentProfile).toHaveBeenCalledTimes(4);
    } finally {
      await app.close();
    }
  });

  it.each(["unavailable", "invalid"] as const)("returns 503 instead of falling back when the active profile is %s", async (status) => {
    const provider: ActiveAgentProfileProvider = {
      getActiveAgentProfile: () => Promise.resolve({ status, error: `${status} daemon profile` }),
    };
    const app = await buildApp({
      agentProfileProvider: provider,
      config: emptyConfigService(),
      clientDist: false,
      logger: false,
    });

    try {
      const packages = await app.inject({ method: "GET", url: "/api/pi-packages" });
      const plugins = await app.inject({ method: "GET", url: "/api/plugins" });
      const manifest = await app.inject({ method: "GET", url: "/pi-web-plugins/manifest.json" });

      expect(packages.statusCode).toBe(503);
      expect(packages.json()).toEqual({ error: `Active agent profile is ${status}: ${status} daemon profile` });
      expect(plugins.statusCode).toBe(503);
      expect(plugins.json()).toEqual({ error: `Active agent profile is ${status}: ${status} daemon profile` });
      expect(manifest.statusCode).toBe(503);
      expect(manifest.json()).toEqual({ error: `Active agent profile is ${status}: ${status} daemon profile` });
    } finally {
      await app.close();
    }
  });
});

function activeProfile(revisionCharacter: string, command: string, dir: string): ActiveAgentProfileDescriptor {
  return {
    schemaVersion: 1,
    revision: `sha256:${revisionCharacter.repeat(64)}`,
    command,
    dir,
    sessionDirEnvKeys: ["PI_WEB_AGENT_SESSION_DIR"],
  };
}

async function writePiPackageSettings(agentDir: string, packages: string[]): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages }, null, 2)}\n`, "utf8");
}

async function writePackagePlugin(root: string, pluginId: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: `@test/${pluginId}`,
    version: "1.0.0",
    piWeb: { plugins: [{ id: pluginId, module: "pi-web-plugin.js" }] },
  }, null, 2)}\n`, "utf8");
  await writeFile(join(root, "pi-web-plugin.js"), "export default {};\n", "utf8");
}

function emptyConfigService(): PiWebConfigService {
  const response: PiWebConfigResponse = {
    path: join(tempDir, "config.json"),
    exists: false,
    config: {},
    effectiveConfig: {},
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      agentCommand: false,
      agentDir: false,
      agentSessionDir: false,
    },
  };
  return {
    read: () => Promise.resolve(response),
    write: () => Promise.resolve(response),
  };
}

function packageSources(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value["packages"])) return [];
  return value["packages"].flatMap((entry) => isRecord(entry) && typeof entry["source"] === "string" ? [entry["source"]] : []);
}

function pluginIds(value: unknown): PiWebPluginInfo["id"][] {
  if (!isRecord(value) || !Array.isArray(value["plugins"])) return [];
  return value["plugins"].flatMap((entry) => isRecord(entry) && typeof entry["id"] === "string" ? [entry["id"]] : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
