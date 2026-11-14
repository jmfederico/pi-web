import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { boundedText, type FailureCode } from "./protocol.js";

/** Parents must exist. Resolve their symlinks before asking the user to confirm. */
export async function resolveDestination(input: string, cwd: string): Promise<string> {
  const text = boundedText(input, 4096).replace(/^@/u, "");
  const path = resolve(cwd, text.startsWith("~/") ? join(homedir(), text.slice(2)) : text);
  try { return join(await realpath(dirname(path)), basename(path)); }
  catch { throw new Error("The private input destination's parent directory must exist and be accessible"); }
}

export type WriteOutcome = { status: "saved" } | { status: "failed"; failure: FailureCode };

/** Exclusive creation also rejects symlinks (including dangling links). Never read existing content. */
export async function createPrivateFile(destination: string, secret: string, signal: AbortSignal): Promise<WriteOutcome> {
  let file: FileHandle | undefined;
  let identity: { dev: number; ino: number } | undefined;
  try {
    signal.throwIfAborted();
    if (await resolveDestination(destination, dirname(destination)) !== destination) {
      return { status: "failed", failure: "destination_changed" };
    }
    signal.throwIfAborted();
    file = await open(destination, "wx", 0o600);
    identity = await file.stat();
    signal.throwIfAborted();
    await file.writeFile(secret, { encoding: "utf8", signal });
    await file.sync();
    await file.close();
    file = undefined;
    return { status: "saved" };
  } catch (error) {
    // Never log, stringify, rethrow, or attach the raw error: dependencies can
    // include their arguments in errors. Only fixed outcome codes leave here.
    if (file === undefined) return { status: "failed", failure: errorCode(error) === "EEXIST" ? "exists" : "write_failed" };
    try {
      await file.close();
      const current = await lstat(destination);
      if (current.dev !== identity?.dev || current.ino !== identity.ino) {
        return { status: "failed", failure: "write_uncertain" };
      }
      await unlink(destination);
      return { status: "failed", failure: "write_failed" };
    } catch { return { status: "failed", failure: "write_uncertain" }; }
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
