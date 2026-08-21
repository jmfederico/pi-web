import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piWebResourceLoaderOptions } from "./piSessionService.js";

/**
 * Exercised against pi's real resource loader: the value of this seam is that
 * plugin-shipped prompt templates and skills actually land in sessions, and
 * that they load last so project and user resources with the same name shadow
 * them — only pi's load order can prove that contract.
 */
describe("piWebResourceLoaderOptions plugin session resources", () => {
  let root = "";
  let agentDir = "";
  let cwd = "";
  let pluginRoot = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-plugin-resources-"));
    agentDir = join(root, "agent");
    cwd = join(root, "workspace");
    pluginRoot = join(root, "plugin");
    await mkdir(agentDir);
    await mkdir(cwd);
    await mkdir(join(pluginRoot, "prompts"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "relay"), { recursive: true });
    await writeFile(join(pluginRoot, "prompts", "relay.md"), "---\ndescription: Plugin relay prompt\n---\nPlugin body.\n", "utf8");
    await writeFile(join(pluginRoot, "skills", "relay", "SKILL.md"), "---\nname: relay\ndescription: Plugin relay skill\n---\nPlugin body.\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function loadResources() {
    const options = piWebResourceLoaderOptions([], {
      promptTemplatePaths: [join(pluginRoot, "prompts")],
      skillPaths: [join(pluginRoot, "skills")],
    });
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, ...(options ?? {}) });
    await loader.reload();
    return loader;
  }

  it("adds plugin prompt templates and skills to the loader", async () => {
    const loader = await loadResources();

    expect(loader.getPrompts().prompts.map((prompt) => prompt.name)).toContain("relay");
    expect(loader.getSkills().skills.map((skill) => skill.name)).toContain("relay");
  });

  it("lets a project prompt template shadow the plugin's with the same name", async () => {
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    await writeFile(join(cwd, ".pi", "prompts", "relay.md"), "---\ndescription: Project relay prompt\n---\nProject body.\n", "utf8");

    const loader = await loadResources();

    const relays = loader.getPrompts().prompts.filter((prompt) => prompt.name === "relay");
    expect(relays).toHaveLength(1);
    expect(relays[0]?.description).toBe("Project relay prompt");
  });

  it("lets a user skill shadow the plugin's with the same name", async () => {
    await mkdir(join(agentDir, "skills", "relay"), { recursive: true });
    await writeFile(join(agentDir, "skills", "relay", "SKILL.md"), "---\nname: relay\ndescription: User relay skill\n---\nUser body.\n", "utf8");

    const loader = await loadResources();

    const relays = loader.getSkills().skills.filter((skill) => skill.name === "relay");
    expect(relays).toHaveLength(1);
    expect(relays[0]?.description).toBe("User relay skill");
  });

  it("returns undefined when there are no sections and no plugin resources", () => {
    expect(piWebResourceLoaderOptions([], { promptTemplatePaths: [], skillPaths: [] })).toBeUndefined();
  });
});
