import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicApiDeclarationPaths = [
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
  "shared/pluginApiTypes.d.ts",
];

describe("public API delivery artifacts", () => {
  it("keeps the browser API type-only and exports the supported server runtime contract", async () => {
    const metadata = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    expect(metadata.exports).toEqual({
      "./plugin-api": { types: "./dist/plugin-api.d.ts" },
      "./server-plugin-api": {
        types: "./dist/server-plugin-api.d.ts",
        import: "./dist/server-plugin-api.js",
      },
    });
    expect(metadata.typesVersions).toEqual({
      "*": {
        "plugin-api": ["dist/plugin-api.d.ts"],
        "server-plugin-api": ["dist/server-plugin-api.d.ts"],
      },
    });
  });

  it("matches the committed browser and server plugin API declaration baseline", async () => {
    for (const declarationPath of publicApiDeclarationPaths) {
      const [actual, baseline] = await Promise.all([
        readFile(join(repoRoot, "dist", declarationPath), "utf8"),
        readFile(join(repoRoot, "test-fixtures", "plugin-api-baseline", declarationPath), "utf8"),
      ]);
      expect(
        normalizeLineEndings(actual),
        `${declarationPath} changed; update the baseline only for an intentional public API change`,
      ).toBe(normalizeLineEndings(baseline));
      expect(
        actual,
        `${declarationPath} must not expose the host-internal terminal command-run filter`,
      ).not.toContain("TerminalCommandRunFilter");
    }
  });
});

function normalizeLineEndings(contents) {
  return contents.replaceAll("\r\n", "\n");
}
