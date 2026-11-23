import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ProjectTrustStore } from "../../piSdk.js";
import { createServerPluginProjectTrustCapabilityFactory } from "./serverPluginProjectTrustCapability.js";

it("reads explicit saved/default trust without auto-trusting empty workspaces or trusting project settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-project-trust-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const cwd = join(root, "workspace"); await mkdir(join(cwd, ".pi"), { recursive: true });
  const project = { id: "p", name: "Project", path: cwd, createdAt: "2026-09-10T00:00:00.000Z" };
  const workspace = { id: "w", projectId: "p", path: cwd, label: "Workspace", isMain: true };
  const lifetime = new AbortController();
  const instance = createServerPluginProjectTrustCapabilityFactory({
    agentDir, projects: { requireProject: () => Promise.resolve(project) },
    workspaces: { checkCurrent: () => Promise.resolve({ status: "folder", projectId: "p", workspaces: [workspace], diagnostics: [] }) },
  }).create({ pluginId: "example", packageRoot: root, lifetimeSignal: lifetime.signal });
  const selection = { projectId: "p", workspaceId: "w" };
  expect(await instance.value.get(selection)).toBe(false);
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  expect(await instance.value.get(selection)).toBe(false);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
  expect(await instance.value.get(selection)).toBe(true);
  new ProjectTrustStore(agentDir).set(cwd, false);
  expect(await instance.value.get(selection)).toBe(false);
  new ProjectTrustStore(agentDir).set(cwd, true);
  expect(await instance.value.get(selection)).toBe(true);
  await expect(instance.value.get({ ...selection, workspaceId: "unknown" })).rejects.toThrow();
  await instance.dispose?.(new AbortController().signal);
  await expect(instance.value.get(selection)).rejects.toThrow();
});
