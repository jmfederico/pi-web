import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const terminalsSourceDir = join(repoRoot, "src", "server", "terminals");
const loaderSourcePath = join(terminalsSourceDir, "nodePtyModule.ts");
const sharedLoaderRelativePath = "src/server/terminals/nodePtyModule.ts";
const pluginLoaderRelativePath = "pi-web-plugins/terminal/server/nodePtyModule.ts";

/**
 * SPEC D4: doctor and the terminal backend must share one node-pty loader. The r1 drift
 * ("doctor ✓ while terminals ✗") was only possible because two independent loaders resolved
 * node-pty on their own, so this asserts the invariant structurally over the source tree.
 */
describe("node-pty loader ownership (SPEC D4)", () => {
  it("keeps exactly one module that loads node-pty per tree", async () => {
    const loaders: string[] = [];
    for (const path of await sourceFiles(join(repoRoot, "src"))) {
      if (path.endsWith(".test.ts")) continue;
      if (nodePtyModuleLoaders(readFileSync(path, "utf8"))) loaders.push(relativeToRepo(path));
    }

    expect(loaders).toEqual([sharedLoaderRelativePath]);

    // The bundled Terminal plugin is a separate source tree with its own loader counterpart
    // (see pi-web-plugins/terminal/server/nodePtyModule.ts): assert the same invariant there,
    // so a stray direct import can never reintroduce the r1 doctor-vs-terminals drift.
    const pluginLoaders: string[] = [];
    for (const path of await sourceFiles(join(repoRoot, "pi-web-plugins", "terminal"))) {
      if (path.endsWith(".test.ts")) continue;
      if (nodePtyModuleLoaders(readFileSync(path, "utf8"))) pluginLoaders.push(relativeToRepo(path));
    }
    expect(pluginLoaders).toEqual([pluginLoaderRelativePath]);
  });

  it("has the doctor check consume the shared loader", () => {
    expect(readFileSync(loaderSourcePath, "utf8")).toMatch(/export function loadNodePtyModule\b/u);

    const path = "src/server/diagnostics/nodePtyNativeModule.ts";
    const contents = readFileSync(join(repoRoot, path), "utf8");
    expect(contents, `${path} must load node-pty through the shared loader`).toMatch(/from\s+["'][^"]*nodePtyModule\.js"/u);
    expect(contents, `${path} must reference the shared loader`).toMatch(/\bloadNodePtyModule\b/u);
  });

  it("keeps the Terminal plugin server free of static node-pty imports", () => {
    // The r1 daemon crash: a missing optional node-pty killed the required Terminal plugin at
    // import time even under Bun, where the plugin never needs it. The plugin may only reach
    // node-pty lazily through its loader, selected by the backend factory.
    const servicePath = join(repoRoot, "pi-web-plugins", "terminal", "server", "terminalService.ts");
    const service = readFileSync(servicePath, "utf8");
    expect(service).not.toMatch(/from\s+["']node-pty["']/u);
    expect(service).toMatch(/from\s+["']\.\/ptyBackend\.js["']/u);
  });
});

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
  return files;
}

/** Matches a call that loads the node-pty binding itself, not a subpath such as package.json. */
function nodePtyModuleLoaders(contents: string): boolean {
  return /\(\s*["']node-pty["']\s*\)/u.test(contents) || /\bfrom\s+["']node-pty["']/u.test(contents);
}

function relativeToRepo(path: string): string {
  return toPosix(path.slice(repoRoot.length + 1));
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}
