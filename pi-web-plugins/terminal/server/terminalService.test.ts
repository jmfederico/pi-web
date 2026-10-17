import { describe, expect, it } from "vitest";
import { interactiveShellArgs } from "./terminalService";

describe("interactive shell arguments", () => {
  it.each([
    { shell: "bash", expected: ["-l"] },
    { shell: "/usr/local/bin/zsh", expected: ["-l"] },
    { shell: "/opt/homebrew/bin/fish", expected: ["-l"] },
    { shell: String.raw`C:\Program Files\Git\bin\bash.exe`, expected: ["-l"] },
    { shell: "/bin/dash", expected: [] },
    { shell: "pwsh", expected: [] },
    { shell: "powershell.exe", expected: [] },
    { shell: "cmd.exe", expected: [] },
  ])("uses login mode only for a supported shell: $shell", ({ shell, expected }) => {
    expect(interactiveShellArgs(shell)).toEqual(expected);
  });
});


