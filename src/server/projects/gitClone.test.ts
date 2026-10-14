import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGitCloneEnvironment, gitCloneErrorMessage, validateGitRepositoryUrl } from "./gitClone.js";

const execFileAsync = promisify(execFile);

describe("validateGitRepositoryUrl", () => {
  it.each([
    "https://git.example.com/team/project.git",
    "ssh://git@git.example.com/team/project.git",
    "git@git.example.com:team/project.git",
    "git@[2001:db8::1]:team/project.git",
  ])("accepts supported remote URL %s", (url) => {
    expect(validateGitRepositoryUrl(url)).toBe(url);
  });

  it.each([
    "",
    "https://user:secret@git.example.com/team/project.git",
    "https://user@git.example.com/team/project.git",
    "https://git.example.com/team/project.git?token=secret",
    "https://git.example.com/team/project.git#branch",
    "file:///tmp/project",
    "ext::sh -c 'echo unsafe'",
    "/tmp/project",
    "../project",
    "C:\\work\\project",
    "-git.example.com:team/project.git",
    "git@-git.example.com:team/project.git",
    "ssh://-git.example.com/team/project.git",
  ])("rejects unsupported or unsafe URL %s", (url) => {
    expect(() => validateGitRepositoryUrl(url)).toThrow();
  });
});

describe("gitCloneErrorMessage", () => {
  it("reports an execFile timeout before progress output", () => {
    const timeoutError = Object.assign(new Error("Command failed"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "Receiving objects: 30%",
    });

    expect(gitCloneErrorMessage(timeoutError)).toBe("the operation exceeded the 10 minute limit");
  });
});

describe("createGitCloneEnvironment", () => {
  it("preserves a configured core.sshCommand and lets Git invoke it", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-web-git-ssh-command-test-"));
    try {
      const configPath = join(tempDir, "gitconfig");
      const sshCommandPath = join(tempDir, "custom-ssh");
      const markerPath = join(tempDir, "ssh-invoked");
      await writeFile(sshCommandPath, "#!/bin/sh\nprintf invoked > \"$PI_WEB_SSH_MARKER\"\nexit 1\n");
      await chmod(sshCommandPath, 0o700);
      await writeFile(configPath, `[core]\n\tsshCommand = ${sshCommandPath}\n`);
      const environment: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: configPath, PI_WEB_SSH_MARKER: markerPath };
      delete environment["GIT_SSH_COMMAND"];
      delete environment["GIT_SSH"];

      const cloneEnvironment = await createGitCloneEnvironment(environment);
      expect(cloneEnvironment["GIT_SSH_COMMAND"]).toBeUndefined();
      await expect(execFileAsync("git", ["clone", "--", "ssh://git@example.invalid/team/project.git", join(tempDir, "project")], {
        encoding: "utf8",
        env: cloneEnvironment,
        timeout: 10_000,
      })).rejects.toThrow();
      expect(await readFile(markerPath, "utf8")).toBe("invoked");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  const sshEnvironments: NodeJS.ProcessEnv[] = [
    { GIT_SSH_COMMAND: "ssh -F /tmp/custom-ssh-config" },
    { GIT_SSH: "/usr/local/bin/custom-ssh" },
  ];
  it.each(sshEnvironments)("preserves explicit SSH environment configuration %#", async (sshEnvironment) => {
    const environment = { ...process.env, ...sshEnvironment };

    const cloneEnvironment = await createGitCloneEnvironment(environment);

    expect(cloneEnvironment["GIT_SSH_COMMAND"]).toBe(sshEnvironment["GIT_SSH_COMMAND"]);
    expect(cloneEnvironment["GIT_SSH"]).toBe(sshEnvironment["GIT_SSH"]);
  });
});
