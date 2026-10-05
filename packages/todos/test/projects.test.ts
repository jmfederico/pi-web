import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ServerPluginExecFileRequest, ServerPluginExecFileResult } from "@jmfederico/pi-web/server-plugin-api";
import { afterEach, expect, it } from "vitest";
import { ProjectResolver, normalizeOrigin } from "../src/projects.js";
import { isRecord, resultProject } from "../src/browser/protocol.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.length = 0; });
const signal = new AbortController().signal;
async function git(request: ServerPluginExecFileRequest): Promise<ServerPluginExecFileResult> {
  const env = Object.fromEntries(Object.entries({ ...process.env, ...request.env }).filter(([key]) => !(request.unsetEnv ?? []).includes(key)));
  try {
    const result = await exec(request.file, request.args ?? [], { env, signal: request.signal });
    return { ...result, exitCode: 0, signal: null, stdoutTruncated: false, stderrTruncated: false };
  } catch (error) {
    if (!isRecord(error) || typeof error["code"] !== "number" || typeof error["stdout"] !== "string" || typeof error["stderr"] !== "string") throw error;
    return { exitCode: error["code"], stdout: error["stdout"], stderr: error["stderr"], signal: null, stdoutTruncated: false, stderrTruncated: false };
  }
}
it.each([
  "git@EXAMPLE.com:Owner/Repo.git", "https://user:secret@example.com/Owner/Repo.git/", "ssh://git@example.com:22/Owner/Repo",
  "git://example.com:9418/Owner/Repo.git", "http://example.com:80/Owner/Repo/", "https://example.com:443/Owner/Repo",
])("normalizes equivalent network Git origins without credentials: %s", (origin) => {
  expect(normalizeOrigin(origin)).toBe("example.com/Owner/Repo");
});
it("keeps distinct repository path case and non-default ports", () => {
  expect(normalizeOrigin("ssh://git@example.com:2222/Owner/Repo.git")).toBe("example.com:2222/Owner/Repo");
  expect(normalizeOrigin("https://example.com/owner/repo")).not.toBe(normalizeOrigin("https://example.com/Owner/Repo"));
});
it.each(["/srv/repo.git", "../repo.git", "C:/repo.git", "file:///srv/repo.git", "https://example.com/", "https://example.com/a?secret=x", "not an origin"])("does not share local or unsupported origin: %s", (origin) => {
  expect(normalizeOrigin(origin)).toBeUndefined();
});
it("resolves real Git clones, canonical local paths and durable originating-machine identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "todos-projects-")); roots.push(root);
  const directories = ["a", "b", "repo-a", "repo-b", "plain"];
  for (const name of directories) await mkdir(join(root, name));
  for (const name of ["repo-a", "repo-b"]) await exec("git", ["-C", join(root, name), "init", "--quiet"]);
  await exec("git", ["-C", join(root, "repo-a"), "remote", "add", "origin", "git@example.com:Owner/Repo.git"]);
  await exec("git", ["-C", join(root, "repo-b"), "remote", "add", "origin", "https://example.com/Owner/Repo/"]);
  const a = new ProjectResolver({ dataDirectory: join(root, "a"), execFile: git });
  const b = new ProjectResolver({ dataDirectory: join(root, "b"), execFile: git });
  const shared = resultProject(await a.resolve({ path: join(root, "repo-a") }, signal));
  expect(shared).toEqual(resultProject(await b.resolve({ path: join(root, "repo-b") }, signal)));
  expect(shared).toMatchObject({ kind: "git", label: "Repo" });
  const plain = join(root, "plain");
  const [local, concurrent] = await Promise.all([a.resolve({ path: plain }, signal), a.resolve({ path: plain }, signal)]);
  expect(local).toEqual(concurrent);
  expect(resultProject(local)).toMatchObject({ kind: "local", label: "plain" });
  expect(resultProject(await b.resolve({ path: plain }, signal)).id).not.toBe(resultProject(local).id);
  expect(await new ProjectResolver({ dataDirectory: join(root, "a"), execFile: git }).resolve({ path: plain }, signal)).toEqual(local);
  const alias = join(root, "alias"); await symlink(plain, alias, "junction");
  expect(await a.resolve({ path: alias }, signal)).toEqual(local);
  await exec("git", ["-C", join(root, "repo-a"), "remote", "remove", "origin"]);
  const noOrigin = resultProject(await a.resolve({ path: join(root, "repo-a") }, signal));
  expect(noOrigin.kind).toBe("local");
  expect(noOrigin.id).not.toBe(resultProject(await b.resolve({ path: join(root, "repo-a") }, signal)).id);
  await exec("git", ["-C", join(root, "repo-a"), "remote", "add", "origin", plain]);
  expect(resultProject(await a.resolve({ path: join(root, "repo-a") }, signal))).toEqual(noOrigin);
});
it("rejects invalid paths and exposes Git failures rather than silently choosing a new local identity", async () => {
  const resolver = new ProjectResolver({ dataDirectory: "/not-used", execFile: () => Promise.reject(new Error("Git unavailable")) });
  expect(await resolver.resolve({ path: "relative" }, signal)).toMatchObject({ ok: false, error: { code: "invalid" } });
  await expect(resolver.resolve({ path: tmpdir() }, signal)).rejects.toThrow("Git unavailable");
  const truncated = new ProjectResolver({ dataDirectory: "/not-used", execFile: () => Promise.resolve({ exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: true, stderrTruncated: false }) });
  await expect(truncated.resolve({ path: tmpdir() }, signal)).rejects.toThrow("host bounds");
});
