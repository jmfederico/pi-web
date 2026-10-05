// Delivery-only. Consume built artifacts; a separate temporary source copy checks standalone compilation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { createEventBus, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(root, "packages/todos");
const temp = await mkdtemp(join(tmpdir(), "pi-todos-install-"));
const exec = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm, "Run with npm run smoke:todos");
async function runNpm(args, cwd) {
  return (await exec(process.execPath, [npm, ...args], { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })).stdout;
}
try {
  const packRoot = join(temp, "pack"); await mkdir(packRoot);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  // Consume already-built artifacts, without prepack rebuilding or touching hooks.
  const { scripts: _scripts, ...metadata } = manifest;
  await writeFile(join(packRoot, "package.json"), JSON.stringify(metadata));
  for (const path of metadata.files) await cp(join(packageRoot, path), join(packRoot, path), { recursive: true });
  const packed = JSON.parse(await runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", temp], packRoot))[0];
  const files = packed.files.map((file) => file.path);
  for (const file of ["dist/browser/index.js", "dist/browser/panel.js", "dist/browser/protocol.js", "dist/server.js", "dist/store.js", "dist/companion.js", "docs/usage.md"]) assert.ok(files.includes(file), `Missing ${file}`);
  assert.ok(files.every((file) => !file.startsWith("src/") && !file.includes("node_modules/") && !file.includes(".test.")));
  const install = join(temp, "install"); await mkdir(install);
  await runNpm(["install", "--prefix", install, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", join(temp, packed.filename)], install);
  const installed = join(install, "node_modules/@jmfederico/pi-todos");
  // Explicit peer provisioning, analogous to installing PI WEB beside the package.
  // The separate root smoke owns a complete actual host npm installation.
  await symlink(root, join(install, "node_modules/@jmfederico/pi-web"), "junction");
  await symlink(join(root, "node_modules/@earendil-works"), join(install, "node_modules/@earendil-works"), "junction");
  await symlink(join(root, "node_modules/@types"), join(install, "node_modules/@types"), "junction");
  const source = join(install, "source-check"); await mkdir(source);
  await cp(join(packageRoot, "src"), join(source, "src"), { recursive: true });
  await cp(join(packageRoot, "tsconfig.json"), join(source, "tsconfig.json"));
  await cp(join(packageRoot, "package.json"), join(source, "package.json"));
  await runNpm(["run", "build"], source); // No repository paths override or host-internal imports.
  const entry = manifest.piWeb.plugins[0];
  assert.equal(entry.id, "todos");
  assert.equal(entry.defaultEnabled, false);
  let bytes = 0;
  for (const file of files) bytes += (await stat(join(installed, file))).size;
  assert.ok(bytes < 16 * 1024 * 1024 && files.length < 4096, "Package exceeds host catalog limits");
  for (const file of await readdir(join(installed, entry.browserRoot))) {
    const path = join(installed, entry.browserRoot, file);
    const source = await readFile(path, "utf8");
    for (const imported of ts.preProcessFile(source, true, false).importedFiles) {
      assert.match(imported.fileName, /^\.\//u, "Browser imports must remain inside browserRoot");
      assert.ok((await stat(resolve(dirname(path), imported.fileName))).isFile());
    }
  }
  const { default: server } = await import(pathToFileURL(join(installed, entry.serverModule)).href);
  const dataDirectory = join(temp, "plugin-data"); await mkdir(dataDirectory);
  const lifetime = new AbortController();
  const context = { dataDirectory, settings: { role: "server" }, lifetimeSignal: lifetime.signal };
  let activation = await server.activate(context);
  const request = (operation, input) => activation.backend.request({ operation, input, signal: new AbortController().signal });
  const created = await request("mutate", { title: "Installed task", context: "Durable central authority" });
  assert.equal(created.ok, true);
  await activation.dispose();
  activation = await server.activate(context);
  assert.deepEqual(await request("read", { id: created.task.id }), created);
  await activation.dispose();
  const settingsManager = SettingsManager.inMemory({ packages: [installed] });
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: join(temp, "agent"), settingsManager, eventBus: createEventBus(),
    noSkills: true, noPromptTemplates: true, noThemes: true, agentsFilesOverride: () => ({ agentsFiles: [] }) });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "Installed compiled companion must load through native Pi");
  const tools = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert.deepEqual(tools.sort(), ["todos_list", "todos_mutate", "todos_read"]);
  assert.deepEqual(await readdir(join(root, "dist/pi-packages")).then((names) => names.filter((name) => name === "todos")), [], "To-dos must not ship in the host");
  const { KNOWN_PI_PACKAGES } = await import(pathToFileURL(join(root, "dist/server/knownPiPackages.js")).href);
  assert.ok(KNOWN_PI_PACKAGES.every((item) => item.id !== "@jmfederico/pi-todos"), "To-dos must not become a known automatic package");
  console.log("Standalone to-do source build, npm install, browser graph, SQLite persistence and native companion discovery passed (explicit current host peer; not bundled/known).");
} finally { await rm(temp, { recursive: true, force: true }); }
