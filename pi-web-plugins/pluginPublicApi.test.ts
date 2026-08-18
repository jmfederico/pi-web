import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const pluginRoot = "pi-web-plugins";
const forbiddenPatterns = [
  { pattern: /\bfetch\s*\(/u, message: "direct browser fetch" },
  { pattern: /["'`](?:api\/|[^"'`]*\/api\/)/u, message: "direct PI WEB API URL" },
  { pattern: /["'`](?:pi-web-plugins\/|[^"'`]*\/pi-web-plugins\/)/u, message: "direct PI WEB plugin URL" },
  { pattern: /piWebInternal/u, message: "legacy internal plugin context" },
  { pattern: /(?:\.\.\/)+src\//u, message: "imports from PI WEB source internals" },
  { pattern: /from\s+["']fastify["']/u, message: "imports Fastify instead of the server plugin API" },
  { pattern: /from\s+["']node:child_process["']/u, message: "bypasses the bounded server command helper" },
  { pattern: /@jmfederico\/pi-web\/(?:dist|src)\//u, message: "imports unpublished PI WEB internals" },
];

describe("bundled PI WEB plugins", () => {
  it("uses public browser and server plugin APIs instead of direct PI WEB internals", async () => {
    const violations: string[] = [];
    for (const file of await pluginSourceFiles(pluginRoot)) {
      const content = await readFile(file, "utf8");
      for (const { pattern, message } of forbiddenPatterns) {
        if (pattern.test(content)) violations.push(`${file}: ${message}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps the bundled Git browser graph on the public API and package-local modules", async () => {
    const root = resolve("pi-web-plugins/git/browser");
    const entry = resolve(root, "pi-web-plugin.ts");
    const pending = [entry];
    const visited = new Set<string>();
    const violations: string[] = [];

    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      const source = await readFile(file, "utf8");
      for (const specifier of moduleSpecifiers(source)) {
        if (specifier === "@jmfederico/pi-web/plugin-api") continue;
        if (!specifier.startsWith("./")) {
          violations.push(`${relative(process.cwd(), file)}: browser import ${specifier}`);
          continue;
        }
        const dependency = resolve(dirname(file), specifier.replace(/\.js$/u, ".ts"));
        if (dependency !== root && !dependency.startsWith(`${root}${sep}`)) {
          violations.push(`${relative(process.cwd(), file)}: browser import escapes the Git package (${specifier})`);
          continue;
        }
        pending.push(dependency);
      }
    }

    expect(violations).toEqual([]);
    expect([...visited].map((file) => relative(root, file)).sort()).toContain("git-panel.ts");
  });
});

function moduleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

async function pluginSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await pluginSourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}
