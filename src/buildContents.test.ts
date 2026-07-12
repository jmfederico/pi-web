import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production build contents", () => {
  // Constructing the full compiler graph can exceed Vitest's default timeout under parallel-suite CPU contention.
  it("keeps test-support modules out of the TypeScript build graph", { timeout: 15_000 }, () => {
    const buildConfig = readBuildConfig();
    const program = ts.createProgram({ rootNames: buildConfig.fileNames, options: buildConfig.options });
    const projectSources = program.getSourceFiles()
      .map((sourceFile) => normalizePath(relative(repoRoot, sourceFile.fileName)))
      .filter((path) => path.startsWith("src/"));

    expect(projectSources).toContain("src/server/app.ts");
    expect(projectSources.filter(isTestSupportPath)).toEqual([]);
  });

  it("keeps test-support artifacts out of the npm tarball", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-web-package-contents-"));
    try {
      const fixtureDist = join(fixtureRoot, "dist", "server");
      await mkdir(fixtureDist, { recursive: true });
      await Promise.all([
        copyFile(join(repoRoot, "package.json"), join(fixtureRoot, "package.json")),
        writeFile(join(fixtureDist, "app.js"), "export {};\n", "utf8"),
        writeFile(join(fixtureDist, "app.testSupport.js"), "export {};\n", "utf8"),
        writeFile(join(fixtureDist, "app.testSupport.js.map"), "{}\n", "utf8"),
      ]);

      const npmExecPath = process.env["npm_execpath"];
      if (npmExecPath === undefined || npmExecPath.length === 0) {
        throw new Error("npm_execpath is required to verify npm package contents");
      }
      const stdout = await execUtf8(process.execPath, [npmExecPath, "pack", "--dry-run", "--json", "--ignore-scripts"], fixtureRoot);
      const packagedFiles = packageFilePaths(stdout);

      expect(packagedFiles).toContain("dist/server/app.js");
      expect(packagedFiles.filter(isTestSupportPath)).toEqual([]);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

function readBuildConfig(): ts.ParsedCommandLine {
  const configPath = join(repoRoot, "tsconfig.build.json");
  const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(formatDiagnostics([diagnostic]));
    },
  });
  if (config === undefined) throw new Error(`Unable to parse ${configPath}`);
  if (config.errors.length > 0) throw new Error(formatDiagnostics(config.errors));
  return config;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
}

function normalizePath(path: string): string {
  return path.split(sep).join("/");
}

function isTestSupportPath(path: string): boolean {
  return path.includes(".testSupport.");
}

function execUtf8(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        reject(error instanceof Error ? error : new Error("Command failed"));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

function packageFilePaths(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack returned an unexpected result");

  const packResult: unknown = parsed[0];
  if (!isRecord(packResult)) throw new Error("npm pack result was not an object");
  const filesValue = packResult["files"];
  if (!Array.isArray(filesValue)) throw new Error("npm pack result did not include files");
  const files: unknown[] = filesValue;

  return files.map((file) => {
    if (!isRecord(file) || typeof file["path"] !== "string") {
      throw new Error("npm pack returned an invalid file entry");
    }
    return file["path"];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
