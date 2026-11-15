import { link, lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

/** Claim a new destination without following final symlinks. Never read existing content. */
export async function createPrivateFile(destination: string, secret: string, signal: AbortSignal): Promise<WriteOutcome> {
  let file: FileHandle | undefined;
  let identity: { dev: number; ino: number } | undefined;
  let temporary: string | undefined;
  let destinationCreated = false;
  try {
    signal.throwIfAborted();
    if (await resolveDestination(destination, dirname(destination)) !== destination) {
      return { status: "failed", failure: "destination_changed" };
    }
    signal.throwIfAborted();
    if (process.platform === "win32") {
      // Windows 'wx' follows dangling symlinks. Claim the destination with a
      // hard link instead, then remove the empty temporary alias before writing.
      temporary = join(dirname(destination), `.pi-web-private-input-${randomUUID()}`);
      file = await open(temporary, "wx", 0o600);
      identity = await file.stat();
      await link(temporary, destination);
      destinationCreated = true;
      await unlink(temporary);
      temporary = undefined;
    } else {
      file = await open(destination, "wx", 0o600);
      destinationCreated = true;
      identity = await file.stat();
    }
    signal.throwIfAborted();
    await file.writeFile(secret, { encoding: "utf8", signal });
    await file.sync();
    await file.close();
    file = undefined;
    return { status: "saved" };
  } catch (error) {
    // Never log, stringify, rethrow, or attach the raw error: dependencies can
    // include their arguments in errors. Only fixed outcome codes leave here.
    const failure = errorCode(error) === "EEXIST" ? "exists" : "write_failed";
    if (file === undefined) return { status: "failed", failure };
    try {
      await file.close();
      if (temporary !== undefined) await unlink(temporary);
      // A failed link never grants ownership of the existing destination.
      if (!destinationCreated) return { status: "failed", failure };
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
