import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureNodePtySpawnHelper } from "./nodePtySpawnHelper.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-pty-helper-"));
  roots.push(root);
  const directory = join(root, "prebuilds/darwin-arm64");
  mkdirSync(directory, { recursive: true });
  const helper = join(directory, "spawn-helper");
  writeFileSync(helper, "fixture");
  chmodSync(helper, 0o640);
  const nativePath = join(directory, "pty.node");
  // Native loading is the external boundary; filesystem permission changes are real.
  const require = Object.assign(vi.fn((path: string) => {
    if (path !== nativePath) throw new Error("native module unavailable");
    return {};
  }), createRequire(import.meta.url));
  require.resolve = Object.assign(vi.fn(() => join(root, "package.json")), { paths: () => null });
  return { require, helper, root };
}

describe("macOS node-pty helper repair", () => {
  it("does nothing on other platforms, including dependency resolution", () => {
    const { require } = fixture();
    ensureNodePtySpawnHelper(require, "linux", "arm64");
    expect(require.resolve).not.toHaveBeenCalled();
    expect(require).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("repairs the selected helper, preserves other bits, and tolerates repeated checks", () => {
    const { require, helper, root } = fixture();
    const unused = join(root, "build/Release");
    mkdirSync(unused, { recursive: true });
    writeFileSync(join(unused, "spawn-helper"), "unused");
    chmodSync(join(unused, "spawn-helper"), 0o600);
    ensureNodePtySpawnHelper(require, "darwin", "arm64");
    expect(statSync(helper).mode & 0o777).toBe(0o751);
    expect(statSync(join(unused, "spawn-helper")).mode & 0o777).toBe(0o600);
    chmodSync(helper, 0o750);
    ensureNodePtySpawnHelper(require, "darwin", "arm64");
    expect(statSync(helper).mode & 0o777).toBe(0o750);
  });

  it("reports the helper path, cause and remedy when repair cannot proceed", () => {
    const { require, helper } = fixture();
    rmSync(helper);
    mkdirSync(helper);
    let failure: unknown;
    try { ensureNodePtySpawnHelper(require, "darwin", "arm64"); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected helper repair to fail");
    expect(failure.message).toContain(helper);
    expect(failure.message).toContain("chmod +x");
    expect(failure.cause).toBeInstanceOf(Error);
  });
});
