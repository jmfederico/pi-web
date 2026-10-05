import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { ServerPluginActivationContext, ServerPluginExecFileResult } from "@jmfederico/pi-web/server-plugin-api";
import { isRecord, type ProjectResult } from "./browser/protocol.js";

/** Network origin identity ignores credentials/protocol, but preserves case-sensitive repository paths and non-default ports. */
export function normalizeOrigin(origin: string): string | undefined {
  const value = origin.trim();
  if (/^[A-Za-z]:[\\/]/u.test(value)) return undefined;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(value);
  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : scp === null ? value : `ssh://${scp[1] ?? ""}/${scp[2] ?? ""}`);
  } catch { return undefined; }
  if (!["ssh:", "https:", "http:", "git:"].includes(url.protocol) || url.hostname === "" || url.search !== "" || url.hash !== "") return undefined;
  const path = url.pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (path === "") return undefined;
  const port = (url.protocol === "ssh:" && url.port === "22") || (url.protocol === "git:" && url.port === "9418") ? "" : url.port;
  return `${url.hostname.toLowerCase()}${port === "" ? "" : `:${port}`}/${path}`;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const gitEnvironment = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"];

/** Always runs on the originating backend, before any task operation is routed remotely. */
export class ProjectResolver {
  private machineIdentity: Promise<string> | undefined;
  constructor(private readonly host: Pick<ServerPluginActivationContext, "dataDirectory" | "execFile">) {}
  private async git(path: string, args: string[], signal: AbortSignal): Promise<ServerPluginExecFileResult> {
    const result = await this.host.execFile({ file: "git", args: ["-C", path, ...args], env: { LC_ALL: "C" }, unsetEnv: gitEnvironment, timeoutMs: 5000, signal });
    signal.throwIfAborted();
    if (result.stdoutTruncated || result.stderrTruncated || result.signal !== null) throw new Error("Project Git inspection did not complete within host bounds");
    return result;
  }
  private machineId(): Promise<string> {
    this.machineIdentity ??= this.loadMachineId();
    return this.machineIdentity;
  }
  private async loadMachineId(): Promise<string> {
    const path = join(this.host.dataDirectory, "project-machine-id");
    try { await writeFile(path, randomUUID(), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!isRecord(error) || error["code"] !== "EEXIST") throw error; }
    const id = (await readFile(path, "utf8")).trim();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) throw new Error("Invalid persistent to-do project machine identity");
    return id;
  }
  async resolve(input: unknown, signal: AbortSignal): Promise<ProjectResult> {
    if (!isRecord(input) || Object.keys(input).some((key) => key !== "path") || typeof input["path"] !== "string" || input["path"].length > 4096 || !isAbsolute(input["path"])) {
      return { ok: false, error: { code: "invalid", message: "Project resolution requires an absolute directory path on this machine" } };
    }
    let path = await realpath(input["path"]);
    const root = await this.git(path, ["rev-parse", "--show-toplevel"], signal);
    let origin: string | undefined;
    if (root.exitCode === 0) {
      path = await realpath(root.stdout.trim());
      const remote = await this.git(path, ["config", "--get", "remote.origin.url"], signal);
      if (remote.exitCode === 0) origin = normalizeOrigin(remote.stdout);
      else if (remote.exitCode !== 1 || remote.stderr.trim() !== "") throw new Error(`Cannot inspect project origin: ${remote.stderr}`);
    } else if (root.exitCode !== 128 || !root.stderr.includes("not a git repository")) {
      throw new Error(`Cannot inspect project repository: ${root.stderr}`);
    }
    const kind = origin === undefined ? "local" : "git";
    const id = origin === undefined ? `local:${await this.machineId()}:${hash(path)}` : `git:${hash(origin)}`;
    signal.throwIfAborted();
    // No credentials or local paths are persisted in task descriptors.
    const label = (origin === undefined ? basename(path) : basename(origin)).slice(0, 200) || "Project";
    return { ok: true, project: { id, label, kind } };
  }
}
