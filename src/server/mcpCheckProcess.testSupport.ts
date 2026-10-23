import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect } from "vitest";

function alreadyExited(error: unknown): boolean {
  return error instanceof Error && (["ENOENT", "ESRCH"].includes(String(Reflect.get(error, "code")))
    || (Reflect.get(error, "code") === 1 && String(Reflect.get(error, "stdout")).trim() === ""));
}

/** Only kill a fixture PID if its command still contains the unique fixture path. */
export async function killFixtureProcess(pidPath: string): Promise<void> {
  try {
    const pid = Number(await readFile(pidPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    const command = process.platform === "linux"
      ? await readFile(`/proc/${String(pid)}/cmdline`, "utf8")
      : (await promisify(execFile)("ps", ["-ww", "-p", String(pid), "-o", "command="])).stdout;
    // A stale fixture PID file must not authorize killing a reused PID.
    if (command.includes(pidPath)) process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!alreadyExited(error)) throw error;
  }
}

export async function expectStopped(pid: number): Promise<void> {
  try {
    process.kill(pid, 0);
    // Reparented zombies have exited, but may not yet have been reaped by init.
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${String(pid)}/status`, "utf8");
      expect(status).toMatch(/State:\s+Z/);
    } else {
      const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "stat="]);
      expect(stdout.trim()).toMatch(/^Z/);
    }
  } catch (error) {
    if (!alreadyExited(error)) throw error;
  }
}
