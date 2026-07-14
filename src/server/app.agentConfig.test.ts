import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActiveAgentProfileDescriptor, PiWebStatusResponse, PiWebVersionResponse } from "../shared/apiTypes.js";
import { appTestContext, registerAppTestHooks } from "./app.testSupport.js";

registerAppTestHooks();

describe("buildApp active agent profile", () => {
  it.each(["/api/config", "/api/machines/local/config"])("keeps desired writes separate from the active profile and observes a new daemon epoch through %s", async (configRoute) => {
    const originalEnv = captureEnv([
      "PI_WEB_SKIP_VERSION_CHECK",
      "PI_WEB_DOCKER_RUNTIME",
      "PI_WEB_AGENT_COMMAND",
      "PI_WEB_AGENT_DIR",
      "PI_CODING_AGENT_DIR",
    ]);
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    process.env["PI_WEB_DOCKER_RUNTIME"] = "0";
    Reflect.deleteProperty(process.env, "PI_WEB_AGENT_COMMAND");
    Reflect.deleteProperty(process.env, "PI_WEB_AGENT_DIR");
    Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");

    try {
      const initialAgentDir = join(appTestContext.tempDir, "initial-agent");
      const updatedAgentDir = join(appTestContext.tempDir, "updated-agent");
      appTestContext.piWebConfig = { agent: { command: "desired-agent", dir: initialAgentDir } };
      appTestContext.agentProfileResult = { status: "available", profile: activeProfile("a", "active-agent", initialAgentDir) };
      await mkdir(initialAgentDir, { recursive: true });
      await installConfiguredPiWebPackage(updatedAgentDir);
      process.env["PI_WEB_AGENT_DIR"] = updatedAgentDir;

      const initialStatus = await appTestContext.app.inject({ method: "GET", url: "/api/pi-web/status" });
      expect(initialStatus.statusCode).toBe(200);
      expect(initialStatus.json<PiWebStatusResponse>().components.web.installation?.kind).not.toBe("pi-package");

      const updateResponse = await appTestContext.app.inject({
        method: "PUT",
        url: configRoute,
        payload: { config: { agent: { command: "next-agent", dir: updatedAgentDir } } },
      });
      expect(updateResponse.statusCode).toBe(200);

      const desiredWriteStatus = await appTestContext.app.inject({ method: "GET", url: "/api/pi-web/status" });
      const desiredWriteVersion = await appTestContext.app.inject({ method: "GET", url: "/api/pi-web/version" });
      expect(desiredWriteStatus.statusCode).toBe(200);
      expect(desiredWriteStatus.json<PiWebStatusResponse>().components.web.installation?.kind).not.toBe("pi-package");
      expect(desiredWriteVersion.json<PiWebVersionResponse>().components.web.installation?.kind).not.toBe("pi-package");

      appTestContext.agentProfileResult = { status: "available", profile: activeProfile("b", "next-agent", updatedAgentDir) };
      const restartedStatus = await appTestContext.app.inject({ method: "GET", url: "/api/pi-web/status?refresh=1" });
      const restartedVersion = await appTestContext.app.inject({ method: "GET", url: "/api/pi-web/version" });

      expect(restartedStatus.statusCode).toBe(200);
      expect(restartedStatus.json<PiWebStatusResponse>().components.web.installation).toMatchObject({
        kind: "pi-package",
        source: process.cwd(),
        scope: "user",
      });
      expect(restartedVersion.json<PiWebVersionResponse>().components.web.installation).toMatchObject({
        kind: "pi-package",
        source: process.cwd(),
        scope: "user",
      });
    } finally {
      restoreEnv(originalEnv);
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

async function installConfiguredPiWebPackage(agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), `${JSON.stringify({ packages: [process.cwd()] }, null, 2)}\n`, "utf8");
}

function captureEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of values) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}
