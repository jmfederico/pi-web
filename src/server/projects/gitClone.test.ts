import { describe, expect, it } from "vitest";
import { gitCloneErrorMessage, validateGitRepositoryUrl } from "./gitClone.js";

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
