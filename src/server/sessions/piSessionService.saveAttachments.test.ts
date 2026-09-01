import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiWebConfigValues } from "../../shared/apiTypes.js";
import type { PiWebConfigService } from "../configRoutes.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, fakeRuntime, fakeSessionManager, runtimeCreator, sessionGateway, sessionRecord, sessionRef, testModelRuntime } from "./piSessionService.testSupport.js";

const TEST_AGENT_DIR = "/tmp/pi-web-test-agent";
const ATTACHMENTS = [{ kind: "image", mimeType: "image/png", data: "QUJD", name: "shot.png" }];

let workspace: string;
const services: PiSessionService[] = [];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "pi-web-save-attachments-"));
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await rm(workspace, { recursive: true, force: true });
});

function fakeConfigRead(effectiveConfig: PiWebConfigValues): Pick<PiWebConfigService, "read"> {
  return {
    read: () => ({
      path: "/tmp/pi-web-test-config.json",
      exists: true,
      config: effectiveConfig,
      effectiveConfig,
      envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, askUser: false },
    }),
  };
}

function createService(config?: Pick<PiWebConfigService, "read">): PiSessionService {
  const fake = fakeRuntime("session-1", { sessionManager: fakeSessionManager(workspace) });
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: TEST_AGENT_DIR,
    modelRuntime: testModelRuntime,
    createAgentRuntime: runtimeCreator(fake.runtime),
    sessionManager: sessionGateway([sessionRecord("session-1", workspace)]),
    heartbeatIntervalMs: 60_000,
    ...(config === undefined ? {} : { config }),
  });
  services.push(service);
  return service;
}

async function expectSavedPath(service: PiSessionService, folder: string | undefined, expectedFolder: string): Promise<void> {
  const saved = await service.saveAttachments(sessionRef("session-1", workspace), ATTACHMENTS, folder);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.path).toMatch(new RegExp(`^${expectedFolder.replaceAll("/", "\\/")}\\/attachment-.+-shot\\.png$`));
  // The returned path is real: the bytes landed where the response points.
  expect(await readFile(join(workspace, saved[0]?.path ?? ""))).toEqual(Buffer.from("QUJD", "base64"));
}

describe("PiSessionService saveAttachments", () => {
  it("saves to the built-in default folder when nothing is configured", async () => {
    const service = createService();

    await expectSavedPath(service, undefined, ".pi-web/attachments");
  });

  it("uses the configured global default folder when the request has no explicit folder", async () => {
    const service = createService(fakeConfigRead({ attachments: { defaultFolder: "global-attachments" } }));

    await expectSavedPath(service, undefined, "global-attachments");
  });

  it("lets the project-local config override the global default folder", async () => {
    const service = createService(fakeConfigRead({ attachments: { defaultFolder: "global-attachments" } }));
    await mkdir(join(workspace, ".pi-web"), { recursive: true });
    await writeFile(join(workspace, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, attachments: { defaultFolder: "project-attachments" } }, null, 2)}\n`);

    await expectSavedPath(service, undefined, "project-attachments");
  });

  it("lets an explicit request folder win over the configured default", async () => {
    const service = createService(fakeConfigRead({ attachments: { defaultFolder: "global-attachments" } }));

    await expectSavedPath(service, "explicit-attachments", "explicit-attachments");
  });

  it("lets an explicit request folder win over the session cwd's own project-local config", async () => {
    const service = createService(fakeConfigRead({ attachments: { defaultFolder: "global-attachments" } }));
    await mkdir(join(workspace, ".pi-web"), { recursive: true });
    await writeFile(join(workspace, ".pi-web", "config.json"), `${JSON.stringify({ version: 1, attachments: { defaultFolder: "cwd-local-attachments" } }, null, 2)}\n`);

    // The composer resolves the effective folder from the owning project's
    // config and sends it explicitly, so a secondary (worktree) workspace —
    // whose cwd has no, or a different, project-local config — still saves to
    // the folder the label advertised.
    await expectSavedPath(service, "project-attachments", "project-attachments");
  });

  it("fails loudly when the config read fails instead of falling back silently", async () => {
    const service = createService({ read: () => Promise.reject(new Error("broken config file")) });

    await expect(service.saveAttachments(sessionRef("session-1", workspace), ATTACHMENTS)).rejects.toThrow("broken config file");
  });
});
