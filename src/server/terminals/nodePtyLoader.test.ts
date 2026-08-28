import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const terminalsSourceDir = join(repoRoot, "src", "server", "terminals");
const backendSourcePath = join(terminalsSourceDir, "backend.ts");
const loaderSourcePath = join(terminalsSourceDir, "nodePtyModule.ts");
const sharedLoaderRelativePath = "src/server/terminals/nodePtyModule.ts";

/**
 * F1 regression guard.
 *
 * `NodePTYBackend` loaded node-pty with a bare `require("node-pty")`, which is a
 * `ReferenceError` in Node ESM — so terminals were dead for every npm-installed user on Node
 * while this repository's suite stayed green (vite-node injects a `require` shim, and node-pty
 * is installed here). Nothing in-repo can observe that failure mode. This test transpiles the
 * real modules with the build's module/target shape, writes them into a throwaway package layout
 * whose only `node_modules` entry is a **fake** node-pty, and spawns a *real* Node ESM process
 * against it. The probe constructs `new NodePTYBackend()` with no arguments, because injecting a
 * module would pass with the bug present; and it never reads `dist/`, because CI runs
 * `npm test` before `npm run build`.
 */
describe("NodePTYBackend under real Node ESM", () => {
  it("loads the fake node-pty through the shared loader with zero constructor arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-node-pty-esm-"));
    try {
      const serverDir = join(root, "package", "server");
      await mkdir(serverDir, { recursive: true });
      await writeFakeNodePty(join(root, "node_modules", "node-pty"));
      await writeFile(join(root, "package", "package.json"), '{ "type": "module" }\n', "utf8");
      await writeFile(join(serverDir, "nodePtyModule.js"), transpileToEsm(loaderSourcePath), "utf8");

      const backendEsm = transpileToEsm(backendSourcePath);
      assertBackendDependsOnlyOnTheSharedLoader(backendEsm);
      await writeFile(join(serverDir, "backend.js"), backendEsm, "utf8");

      const probePath = join(serverDir, "probe.mjs");
      await writeFile(probePath, esmProbe(), "utf8");
      const result = await run(process.execPath, [probePath], root);

      expect(result.stdout, `node ESM probe output:\n${result.stdout}\n${result.stderr}`).toContain("AVAILABLE:true");
      expect(result.code).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * SPEC D4: doctor and the terminal backend must share one node-pty loader. The r1 drift
 * ("doctor ✓ while terminals ✗") was only possible because two independent loaders resolved
 * node-pty on their own, so this asserts the invariant structurally over the source tree. The
 * runtime half of the proof lives in `nodePtyNativeModule.test.ts`, which mocks the shared
 * loader and shows doctor's default path goes through it.
 */
describe("node-pty loader ownership (SPEC D4)", () => {
  it("keeps exactly one module that loads node-pty", async () => {
    const loaders: string[] = [];
    for (const path of await sourceFiles(join(repoRoot, "src"))) {
      if (path.endsWith(".test.ts")) continue;
      if (nodePtyModuleLoaders(readFileSync(path, "utf8"))) loaders.push(relativeToRepo(path));
    }

    expect(loaders).toEqual([sharedLoaderRelativePath]);
  });

  it("has the terminal backend and the doctor check consume the shared loader", () => {
    expect(readFileSync(loaderSourcePath, "utf8")).toMatch(/export function loadNodePtyModule\b/u);

    for (const path of ["src/server/terminals/backend.ts", "src/server/diagnostics/nodePtyNativeModule.ts"]) {
      const contents = readFileSync(join(repoRoot, path), "utf8");
      expect(contents, `${path} must load node-pty through the shared loader`).toMatch(/from\s+"[^"]*nodePtyModule\.js"/u);
      expect(contents, `${path} must reference the shared loader`).toMatch(/\bloadNodePtyModule\b/u);
    }
  });
});

/** Transpiles one real source file to the ESM shape `tsc -p tsconfig.build.json` emits. */
function transpileToEsm(path: string): string {
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(path, "utf8"), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  if ((diagnostics ?? []).length > 0) {
    throw new Error(`Transpiling ${relativeToRepo(path)} reported diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  return outputText;
}

/**
 * Hermeticity guard: the probe must exercise only these two real modules plus the fake binding.
 * Anything else imported would silently resolve against the repository tree — which has a real
 * node-pty — and the test would pass with the bug present.
 */
function assertBackendDependsOnlyOnTheSharedLoader(backendEsm: string): void {
  const specifiers = [...backendEsm.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1] ?? "");
  expect(specifiers).toEqual(["./nodePtyModule.js"]);
}

function esmProbe(): string {
  return [
    'import { NodePTYBackend } from "./backend.js";',
    "const backend = new NodePTYBackend();",
    "const available = backend.available();",
    "console.log('AVAILABLE:' + String(available));",
    "process.exit(available ? 0 : 1);",
    "",
  ].join("\n");
}

async function writeFakeNodePty(packageDir: string): Promise<void> {
  await mkdir(packageDir, { recursive: true });
  const manifest = JSON.stringify({ name: "node-pty", version: "0.0.0-fake", main: "index.js" }, null, 2);
  await Promise.all([
    writeFile(join(packageDir, "package.json"), `${manifest}\n`, "utf8"),
    writeFile(join(packageDir, "index.js"), "exports.spawn = function spawn() { return {}; };\n", "utf8"),
  ]);
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ code: 0, stdout, stderr });
        return;
      }
      if (typeof error.code !== "number") {
        reject(new Error(`Could not run ${file} ${args.join(" ")}: ${error.message}\n${stderr}`));
        return;
      }
      resolvePromise({ code: error.code, stdout, stderr });
    });
  });
}

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
