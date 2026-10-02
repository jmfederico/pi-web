import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerPluginNoticeInput } from "@jmfederico/pi-web/server-plugin-api";
import { interactiveShellArgs, TerminalService, type TerminalActivitySink, type TerminalInfo, type TerminalWorkspaceScope } from "./terminalService";

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


