import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiWebPluginCatalog } from "../piWebPluginCatalog.js";
import type { PiWebPluginScope } from "../../shared/apiTypes.js";
import { resolvePluginSessionResourcePaths } from "./pluginSessionResources.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-plugin-session-resources-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("resolvePluginSessionResourcePaths", () => {
  it("returns prompts and skills directories of enabled bundled and local plugins", async () => {
    const bundled = await writeFixturePlugin("bundled", "relay-pack", {
      "prompts/relay.md": "---\ndescription: Plan a Relay\n---\nBody.\n",
      "skills/relay/SKILL.md": "---\nname: relay\ndescription: Relay method\n---\nBody.\n",
    });
    const local = await writeFixturePlugin("local", "local-pack", {
      "skills/local/SKILL.md": "---\nname: local\ndescription: Local skill\n---\nBody.\n",
    });

    const paths = await resolvePluginSessionResourcePaths(fixtureCatalog());

    expect(paths).toEqual({
      promptTemplatePaths: [join(bundled, "prompts")],
      // Catalog order is plugin-id order, not root order.
      skillPaths: [join(local, "skills"), join(bundled, "skills")],
    });
  });

  it("omits plugins that ship no Pi resources", async () => {
    await writeFixturePlugin("bundled", "plain", {});

    expect(await resolvePluginSessionResourcePaths(fixtureCatalog())).toEqual({
      promptTemplatePaths: [],
      skillPaths: [],
    });
  });

  it("excludes disabled plugins", async () => {
    await writeFixturePlugin("bundled", "relay-pack", {
      "prompts/relay.md": "---\ndescription: Plan a Relay\n---\nBody.\n",
    });
    const catalog = fixtureCatalog({ plugins: { "relay-pack": { enabled: false } } });

    expect(await resolvePluginSessionResourcePaths(catalog)).toEqual({
      promptTemplatePaths: [],
      skillPaths: [],
    });
  });

  it("excludes Pi-package plugins, whose resources load through pi itself", async () => {
    await writeFixturePlugin("user", "package-pack", {
      "prompts/review.md": "---\ndescription: Review\n---\nBody.\n",
    });

    expect(await resolvePluginSessionResourcePaths(fixtureCatalog())).toEqual({
      promptTemplatePaths: [],
      skillPaths: [],
    });
  });

  it("withholds all resources on a safe start of none", async () => {
    await writeFixturePlugin("bundled", "relay-pack", {
      "prompts/relay.md": "---\ndescription: Plan a Relay\n---\nBody.\n",
    });

    expect(await resolvePluginSessionResourcePaths(fixtureCatalog(), { safeStart: "none" })).toEqual({
      promptTemplatePaths: [],
      skillPaths: [],
    });
  });

  it("withholds local plugin resources on a bundled-only safe start", async () => {
    const bundled = await writeFixturePlugin("bundled", "relay-pack", {
      "skills/relay/SKILL.md": "---\nname: relay\ndescription: Relay method\n---\nBody.\n",
    });
    await writeFixturePlugin("local", "local-pack", {
      "skills/local/SKILL.md": "---\nname: local\ndescription: Local skill\n---\nBody.\n",
    });

    expect(await resolvePluginSessionResourcePaths(fixtureCatalog(), { safeStart: "bundled-only" })).toEqual({
      promptTemplatePaths: [],
      skillPaths: [join(bundled, "skills")],
    });
  });
});

function fixtureCatalog(config: { plugins?: Record<string, { enabled?: boolean }> } = {}): PiWebPluginCatalog {
  return new PiWebPluginCatalog({
    roots: [
      { path: join(tempDir, "bundled"), source: "fixture-bundled", scope: "bundled" },
      { path: join(tempDir, "local"), source: "fixture-local", scope: "local" },
      { path: join(tempDir, "user"), source: "fixture-user", scope: "user" },
    ],
    packageProvider: false,
    configProvider: () => config,
  });
}

async function writeFixturePlugin(scope: PiWebPluginScope, id: string, files: Record<string, string>): Promise<string> {
  const root = join(tempDir, scope, id);
  await mkdir(root, { recursive: true });
  const packageJson = { piWeb: { plugins: [{ id, browserRoot: "dist", module: "dist/plugin.js" }] } };
  await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "plugin.js"), "export default {};\n");
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, content);
  }
  // Canonicalize: the catalog resolves `packageRoot` via `realpath` (e.g. to
  // undo the OS temp dir's 8.3 short-name form on Windows), so the expected
  // paths built from this return value must match that same canonical form.
  return await realpath(root);
}
