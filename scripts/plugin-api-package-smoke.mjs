import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const publicApiDeclarationPaths = [
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
  "shared/pluginApiTypes.d.ts",
];
const expectedPackageDeclarationPaths = [
  ...publicApiDeclarationPaths.map((path) => `dist/${path}`),
  "plugin-api.d.ts",
  "server-plugin-api.d.ts",
].sort();
const firstBrowserPluginApiV2Version = "1.202608.1";
const workspaceProviderExamplePiWebRange = `^${firstBrowserPluginApiV2Version}`;
const pluginConsumerCompilerModes = [
  {
    name: "NodeNext",
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
  },
  {
    name: "Bundler",
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  },
];

export async function smokeInstalledPluginApi({ packageRoot, fixtureRoot, repoRoot }) {
  await assertPublicApiBaseline(packageRoot, repoRoot);
  await assertInstalledDeclarationArtifacts(packageRoot);
  await assertExampleCompatibilityFloor(packageRoot);

  const consumerRoot = join(fixtureRoot, "plugin-api-consumers");
  await cp(join(repoRoot, "test-fixtures", "plugin-api-consumers"), consumerRoot, { recursive: true });
  await cp(join(packageRoot, "examples", "workspace-provider-plugin"), join(consumerRoot, "dual-entry"), { recursive: true });
  await Promise.all([
    mkdir(join(consumerRoot, "node_modules", "@jmfederico"), { recursive: true }),
    mkdir(join(consumerRoot, "node_modules", "@types"), { recursive: true }),
    writeFile(join(consumerRoot, "package.json"), '{"private":true,"type":"module"}\n', "utf8"),
  ]);
  await Promise.all([
    symlink(packageRoot, join(consumerRoot, "node_modules", "@jmfederico", "pi-web"), "dir"),
    symlink(join(repoRoot, "node_modules", "@types", "node"), join(consumerRoot, "node_modules", "@types", "node"), "dir"),
  ]);

  const browserPath = join(consumerRoot, "browser.ts");
  const serverPath = join(consumerRoot, "server.ts");
  const dualEntryPaths = [
    join(consumerRoot, "dual-entry", "src", "browser", "index.ts"),
    join(consumerRoot, "dual-entry", "src", "server.ts"),
  ];

  for (const mode of pluginConsumerCompilerModes) {
    assertPluginApiResolution(browserPath, mode.options, packageRoot);
    assertStrictPluginConsumer("browser-only", [browserPath], mode, packageRoot, repoRoot, [
      "dist/plugin-api.d.ts",
      "dist/shared/pluginApiTypes.d.ts",
    ]);
    assertStrictPluginConsumer("server-only", [serverPath], mode, packageRoot, repoRoot, [
      "dist/server-plugin-api.d.ts",
      "dist/shared/pluginApiTypes.d.ts",
    ]);
    assertStrictPluginConsumer("dual-entry example", dualEntryPaths, mode, packageRoot, repoRoot, [
      "dist/plugin-api.d.ts",
      "dist/server-plugin-api.d.ts",
      "dist/shared/pluginApiTypes.d.ts",
    ], ["node"]);
  }
}

async function assertPublicApiBaseline(packageRoot, repoRoot) {
  for (const declarationPath of publicApiDeclarationPaths) {
    const [actual, baseline] = await Promise.all([
      readFile(join(packageRoot, "dist", declarationPath), "utf8"),
      readFile(join(repoRoot, "test-fixtures", "plugin-api-baseline", declarationPath), "utf8"),
    ]);
    if (normalizeLineEndings(actual) !== normalizeLineEndings(baseline)) {
      throw new Error(`Installed public API declaration differs from its committed baseline; update it only for an intentional API change: ${declarationPath}`);
    }
  }
}

async function assertInstalledDeclarationArtifacts(packageRoot) {
  const actualPaths = await packageDeclarationPaths(packageRoot);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPackageDeclarationPaths)) {
    throw new Error(`Installed package declaration artifacts differ from the explicit public API set; update the baseline only for an intentional API change.\nExpected: ${JSON.stringify(expectedPackageDeclarationPaths, null, 2)}\nReceived: ${JSON.stringify(actualPaths, null, 2)}`);
  }
}

async function assertExampleCompatibilityFloor(packageRoot) {
  const manifestPath = join(packageRoot, "examples", "workspace-provider-plugin", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const actualRange = manifest?.devDependencies?.["@jmfederico/pi-web"];
  if (actualRange !== workspaceProviderExamplePiWebRange) {
    throw new Error(`Installed workspace-provider example must require @jmfederico/pi-web ${workspaceProviderExamplePiWebRange}; received ${JSON.stringify(actualRange)}`);
  }
}

async function packageDeclarationPaths(packageRoot) {
  const declarationPaths = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === packageRoot && entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && isDeclarationPath(entry.name)) {
        declarationPaths.push(normalizePath(relative(packageRoot, path)));
      }
    }
  }

  await visit(packageRoot);
  return declarationPaths.sort();
}

function isDeclarationPath(path) {
  return path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts");
}

function assertPluginApiResolution(consumerPath, compilerOptions, packageRoot) {
  const expectedDeclarations = new Map([
    ["@jmfederico/pi-web/plugin-api", join(packageRoot, "dist", "plugin-api.d.ts")],
    ["@jmfederico/pi-web/server-plugin-api", join(packageRoot, "dist", "server-plugin-api.d.ts")],
  ]);
  for (const [specifier, expected] of expectedDeclarations) {
    const resolved = ts.resolveModuleName(specifier, consumerPath, compilerOptions, ts.sys).resolvedModule;
    if (resolved === undefined || canonicalPath(resolved.resolvedFileName) !== canonicalPath(expected)) {
      throw new Error(`${specifier} did not resolve to the installed public declaration under the consumer compiler mode`);
    }
  }

  for (const specifier of [
    "@jmfederico/pi-web/plugin-api/unstable",
    "@jmfederico/pi-web/dist/plugin-api",
    "@jmfederico/pi-web/dist/shared/pluginApiTypes",
    "@jmfederico/pi-web/package.json",
  ]) {
    if (ts.resolveModuleName(specifier, consumerPath, compilerOptions, ts.sys).resolvedModule !== undefined) {
      throw new Error(`Unsupported package path resolved from the installed package: ${specifier}`);
    }
  }
}

function assertStrictPluginConsumer(label, rootNames, mode, packageRoot, repoRoot, expectedPackageDeclarations, types = []) {
  const program = ts.createProgram({
    rootNames,
    options: {
      ...mode.options,
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noEmit: true,
      skipLibCheck: false,
      types,
      verbatimModuleSyntax: true,
    },
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(`${label} consumer failed under ${mode.name}:\n${formatDiagnostics(diagnostics, repoRoot)}`);
  }

  const realPackageRoot = canonicalPath(packageRoot);
  const sourcePaths = program.getSourceFiles().map((sourceFile) => canonicalPath(sourceFile.fileName));
  const packageDeclarations = sourcePaths
    .map((sourcePath) => normalizePath(relative(realPackageRoot, sourcePath)))
    .filter((sourcePath) => sourcePath.startsWith("dist/") && sourcePath.endsWith(".d.ts"))
    .sort();
  const expectedDeclarations = [...expectedPackageDeclarations].sort();
  if (JSON.stringify(packageDeclarations) !== JSON.stringify(expectedDeclarations)) {
    throw new Error(`${label} consumer loaded an unexpected installed declaration graph under ${mode.name}: ${JSON.stringify(packageDeclarations)}`);
  }

  const unrelatedDependencyMarkers = [
    "/node_modules/@earendil-works/pi-",
    "/node_modules/@anthropic-ai/",
    "/node_modules/@google/",
    "/node_modules/google-auth-library/",
    "/node_modules/google-logging-utils/",
    "/node_modules/@modelcontextprotocol/",
  ];
  const normalizedSourcePaths = sourcePaths.map(normalizePath);
  const unrelatedSources = normalizedSourcePaths.filter((sourcePath) =>
    unrelatedDependencyMarkers.some((marker) => sourcePath.includes(marker))
  );
  if (unrelatedSources.length > 0) {
    throw new Error(`${label} consumer loaded unrelated dependency declarations under ${mode.name}: ${JSON.stringify(unrelatedSources)}`);
  }
}

function canonicalPath(path) {
  return ts.sys.realpath?.(path) ?? resolve(path);
}

function normalizePath(path) {
  return path.split(sep).join("/");
}

function normalizeLineEndings(contents) {
  return contents.replaceAll("\r\n", "\n");
}

function formatDiagnostics(diagnostics, repoRoot) {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
}
