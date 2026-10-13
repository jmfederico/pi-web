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

  // Git's extended transport syntax and Windows drive paths can resemble SCP
  // URLs to a permissive host:path matcher.
  if (repositoryUrl.startsWith("ext::") || /^[A-Za-z]:[\\/]/u.test(repositoryUrl)) {
    throw new Error("Use an HTTPS or SSH Git repository URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    const scpUrl = /^(?:[A-Za-z0-9._-]+@)?(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9._-]+):[^\s?#]+$/u;
    const match = scpUrl.exec(repositoryUrl);
    if (match?.[1] !== undefined && !match[1].startsWith("-")) return repositoryUrl;
    throw new Error("Use an HTTPS or SSH Git repository URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") throw new Error("Use an HTTPS or SSH Git repository URL");
  if (parsed.hostname === "" || parsed.hostname.startsWith("-") || parsed.password !== "" || (parsed.protocol === "https:" && parsed.username !== "")) {
    throw new Error("Remove credentials from the repository URL and use the host's configured Git credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") throw new Error("Repository URLs must not include query parameters or fragments");
  return repositoryUrl;
}

/** Run Git without a shell and prevent interactive credential prompts from hanging the web request. */
export async function cloneGitRepository(repositoryUrl: string, destination: string, signal?: AbortSignal): Promise<void> {
  const configuredSshCommand = process.env["GIT_SSH_COMMAND"]?.trim();
  try {
    await execFileAsync("git", ["clone", "--", repositoryUrl, destination], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: PROJECT_GIT_CLONE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
        GIT_SSH_COMMAND: configuredSshCommand === undefined || configuredSshCommand === "" ? "ssh -o BatchMode=yes" : configuredSshCommand,
      },
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) throw new Error("Git clone was cancelled", { cause: error });
    const message = gitCloneErrorMessage(error);
    throw new Error(message === "" ? "Git clone failed" : `Git clone failed: ${message}`, { cause: error });
  }
}

export function gitCloneErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if ("killed" in error && error.killed === true && "signal" in error && error.signal === "SIGTERM") {
    return "the operation exceeded the 10 minute limit";
  }
  if ("stderr" in error && typeof error.stderr === "string" && error.stderr.trim() !== "") {
    return error.stderr.trim().slice(-4_000);
  }
  if (error.message.includes("ENOENT")) return "Git is not installed or is unavailable on the selected machine";
  return error.message;
}
