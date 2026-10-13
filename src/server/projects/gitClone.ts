import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_GIT_CLONE_TIMEOUT_MS } from "../../shared/projectCloneProtocol.js";

const execFileAsync = promisify(execFile);

/**
 * Clone a repository using the host's existing Git/SSH credentials. Inline
 * credentials and non-network protocols are rejected so secrets do not enter
 * process arguments or server request logs.
 */
export function validateGitRepositoryUrl(value: string): string {
  const repositoryUrl = value.trim();
  if (repositoryUrl === "" || repositoryUrl.length > 2_048) throw new Error("Enter a valid Git repository URL");

  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    const scpUrl = /^(?:[A-Za-z0-9._-]+@)?(?:\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+):[^\s?#]+$/u;
    if (scpUrl.test(repositoryUrl)) return repositoryUrl;
    throw new Error("Use an HTTPS or SSH Git repository URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") throw new Error("Use an HTTPS or SSH Git repository URL");
  if (parsed.hostname === "" || parsed.password !== "" || (parsed.protocol === "https:" && parsed.username !== "")) {
    throw new Error("Remove credentials from the repository URL and use the host's configured Git credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("Repository URLs must not include query parameters or fragments");
  return repositoryUrl;
}

/** Run Git without a shell and prevent interactive credential prompts from hanging the web request. */
export async function cloneGitRepository(repositoryUrl: string, destination: string, signal?: AbortSignal): Promise<void> {
  try {
    await execFileAsync("git", ["clone", "--progress", "--", repositoryUrl, destination], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: PROJECT_GIT_CLONE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) throw new Error("Git clone was cancelled");
    const message = gitCloneErrorMessage(error);
    throw new Error(message === "" ? "Git clone failed" : `Git clone failed: ${message}`, { cause: error });
  }
}

function gitCloneErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim() !== "") {
    return error.stderr.trim().slice(-4_000);
  }
  if ("code" in error && error.code === "ETIMEDOUT") return "the operation exceeded the 10 minute limit";
  if (error.message.includes("ENOENT")) return "Git is not installed or is unavailable on the selected machine";
  return error.message;
}
