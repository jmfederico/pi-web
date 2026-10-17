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
const backendSourcePath = join(repoRoot, "pi-web-plugins", "terminal", "server", "ptyBackend.ts");
const loaderSourcePath = join(terminalsSourceDir, "nodePtyModule.ts");
const runtimeSourcePath = join(repoRoot, "src", "shared", "piWebRuntime.ts");
const sharedLoaderRelativePath = "src/server/terminals/nodePtyModule.ts";
const pluginLoaderRelativePath = "pi-web-plugins/terminal/server/nodePtyModule.ts";

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
      // package/server/terminals mirrors the real dist/ depth so backend.js keeps the exact
      // relative specifiers it ships with.
      const serverDir = join(root, "package", "server", "terminals");
      await Promise.all([
        mkdir(serverDir, { recursive: true }),
        mkdir(join(root, "package", "shared"), { recursive: true }),
      ]);
      await writeFakeNodePty(join(root, "node_modules", "node-pty"));
      await writeFile(join(root, "package", "package.json"), '{ "type": "module" }\n', "utf8");
      await writeFile(join(root, "package", "shared", "piWebRuntime.js"), transpileToEsm(runtimeSourcePath), "utf8");
      await writeFile(join(serverDir, "nodePtyModule.js"), transpileToEsm(loaderSourcePath), "utf8");

      const backendEsm = transpileToEsm(backendSourcePath);
      assertBackendDependsOnlyOnTheSharedLoader(backendEsm);
      await writeFile(join(serverDir, "ptyBackend.js"), backendEsm, "utf8");

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

  it("has the terminal backend and the doctor check consume the shared loader", () => {
    expect(readFileSync(loaderSourcePath, "utf8")).toMatch(/export function loadNodePtyModule\b/u);

    for (const path of ["pi-web-plugins/terminal/server/ptyBackend.ts", "src/server/diagnostics/nodePtyNativeModule.ts"]) {
      const contents = readFileSync(join(repoRoot, path), "utf8");
      expect(contents, `${path} must load node-pty through the shared loader`).toMatch(/from\s+["'][^"']*nodePtyModule\.js["']/u);
      expect(contents, `${path} must reference the shared loader`).toMatch(/\bloadNodePtyModule\b/u);
    }
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
  // The backend must never import node-pty directly; it only reaches node-pty through the
  // shared loader (nodePtyModule.js).  Node builtins are irrelevant.
  const localDeps = specifiers.filter((s) => !s.startsWith("node:"));
  expect(localDeps).toContain("./nodePtyModule.js");
  expect(localDeps).not.toContain("node-pty");
}

function esmProbe(): string {
  return [
    'import { NodePTYBackend } from "./ptyBackend.js";',
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
