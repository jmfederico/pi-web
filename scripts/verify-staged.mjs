import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_LINT_TRIGGERS = new Set([
  "eslint.config.js",
  "tsconfig.json",
]);

const FULL_TEST_TRIGGERS = new Set([
  "tsconfig.json",
  "vitest.config.ts",
]);

const LINTABLE_ROOT_FILES = new Set([
  "vite.config.ts",
  "vitest.config.ts",
]);

const PUBLIC_DECLARATION_FILES = new Set([
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
]);

const LINTABLE_DIRECTORIES = [
  "extensions/",
  "pi-web-plugins/",
  "src/",
];

const RELATED_SOURCE_DIRECTORIES = [
  "extensions/",
  "pi-web-plugins/",
  "plugin-api/",
  "scripts/",
  "src/",
];

// `vitest related` follows imports, but these suites inspect repository assets at runtime.
const DOCKER_TESTS = [
  "src/docker/piWebDockerDocs.test.ts",
  "src/docker/piWebDockerEntrypoint.test.ts",
  "src/server/dockerControlAssets.test.ts",
];

const DOCKER_DOCS_TEST = "src/docker/piWebDockerDocs.test.ts";
const PLUGIN_PUBLIC_API_TEST = "pi-web-plugins/pluginPublicApi.test.ts";

export function parseNullDelimitedPaths(output) {
  const value = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  return value.split("\0").filter((path) => path.length > 0);
}

export function createValidationPlan(stagedPaths, options = {}) {
  const pathExists = options.pathExists ?? existsSync;
  const paths = [...new Set(stagedPaths.map(normalizeRepoPath).filter((path) => path.length > 0))].sort();

  const lint = paths.some((path) => FULL_LINT_TRIGGERS.has(path))
    ? { mode: "full", files: [] }
    : scopedValidation(paths.filter((path) => isLintablePath(path) && pathExists(path)), "scoped");

  const tests = paths.some((path) => FULL_TEST_TRIGGERS.has(path))
    ? { mode: "full", files: [] }
    : scopedValidation(relatedTestInputs(paths), "related");

  return { paths, lint, tests };
}

export function createValidationSteps(plan) {
  const steps = [
    {
      label: "cached whole-project typecheck",
      npmArgs: ["run", "typecheck:cached"],
    },
    {
      label: "whole-project Knip analysis",
      npmArgs: ["run", "knip"],
    },
  ];

  if (plan.lint.mode === "full") {
    steps.push({ label: "full ESLint validation (configuration changed)", npmArgs: ["run", "lint"] });
  } else if (plan.lint.mode === "scoped") {
    steps.push({
      label: `ESLint validation for ${String(plan.lint.files.length)} staged file(s)`,
      npmArgs: ["exec", "--", "eslint", "--", ...plan.lint.files],
    });
  }

  if (plan.tests.mode === "full") {
    steps.push({ label: "full Vitest validation (configuration changed)", npmArgs: ["test"] });
  } else if (plan.tests.mode === "related") {
    steps.push({
      label: `Vitest validation related to ${String(plan.tests.files.length)} staged input(s)`,
      npmArgs: [
        "exec",
        "--",
        "vitest",
        "related",
        "--run",
        "--config",
        "vitest.config.ts",
        "--passWithNoTests",
        ...plan.tests.files,
      ],
    });
  }

  return steps;
}

function readStagedPaths() {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return parseNullDelimitedPaths(output);
}

function relatedTestInputs(paths) {
  const inputs = new Set();

  for (const path of paths) {
    if (isRelatedSourcePath(path)) inputs.add(path);

    if (path.startsWith("docker/")) {
      for (const test of DOCKER_TESTS) inputs.add(test);
    } else if (path === "README.md" || path.startsWith("docs/")) {
      inputs.add(DOCKER_DOCS_TEST);
    }

    if (path.startsWith("pi-web-plugins/")) inputs.add(PLUGIN_PUBLIC_API_TEST);
  }

  return [...inputs].sort();
}

function isLintablePath(path) {
  if (LINTABLE_ROOT_FILES.has(path)) return true;
  return path.endsWith(".ts") && LINTABLE_DIRECTORIES.some((directory) => path.startsWith(directory));
}

function isRelatedSourcePath(path) {
  if (PUBLIC_DECLARATION_FILES.has(path)) return true;
  if (!/\.(?:[cm]?[jt]s|[jt]sx|json)$/u.test(path)) return false;
  return RELATED_SOURCE_DIRECTORIES.some((directory) => path.startsWith(directory));
}

function normalizeRepoPath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function scopedValidation(files, mode) {
  return files.length > 0 ? { mode, files } : { mode: "skip", files: [] };
}

function runNpmStep(step) {
  console.log(`\n[pre-commit] ${step.label}`);
  const invocation = npmInvocation(step.npmArgs);
  const result = spawnSync(invocation.command, invocation.args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
}

function npmInvocation(npmArgs) {
  const npmExecPath = process.env["npm_execpath"];
  if (npmExecPath !== undefined && npmExecPath.length > 0) {
    return { command: process.execPath, args: [npmExecPath, ...npmArgs] };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args: npmArgs,
  };
}

function main() {
  const plan = createValidationPlan(readStagedPaths());
  console.log(`[pre-commit] Planning validation for ${String(plan.paths.length)} staged file(s).`);

  for (const step of createValidationSteps(plan)) {
    const status = runNpmStep(step);
    if (status !== 0) return status;
  }

  if (plan.lint.mode === "skip") console.log("\n[pre-commit] No staged files require ESLint.");
  if (plan.tests.mode === "skip") console.log("[pre-commit] No staged files have related Vitest coverage.");
  return 0;
}

function isDirectExecution() {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  return pathToFileURL(resolve(entryPath)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    process.exitCode = main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pre-commit] ${message}`);
    process.exitCode = 1;
  }
}
