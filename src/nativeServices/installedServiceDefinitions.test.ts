import { TextEncoder } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  inspectInstalledNativeServiceDefinitions,
  type InstalledNativeServiceDefinitionCommandResult,
  type InstalledNativeServiceDefinitionDependencies,
  type InstalledNativeServiceDefinitionSource,
} from "./installedServiceDefinitions.js";

const servicePath = "/home/user/.config/systemd/user/pi-web-web.service";
const launchdPath = "/Users/user/Library/LaunchAgents/com.pi-web.web.plist";
const launchdTarget = "gui/501/com.pi-web.web";
const source: InstalledNativeServiceDefinitionSource = {
  id: "web",
  path: servicePath,
  systemdName: "pi-web-web.service",
  launchdTarget,
};

interface SystemdManagerOverrides {
  LoadState: string;
  FragmentPath: string;
  DropInPaths: string;
  NeedDaemonReload: string;
  EnvironmentFiles: string;
  Environment: string;
}

function managerOutput(overrides: Partial<SystemdManagerOverrides> = {}): string {
  const lines = [
    `LoadState=${overrides.LoadState ?? "loaded"}`,
    `FragmentPath=${overrides.FragmentPath ?? servicePath}`,
    `DropInPaths=${overrides.DropInPaths ?? ""}`,
    `NeedDaemonReload=${overrides.NeedDaemonReload ?? "no"}`,
    `Environment=${overrides.Environment ?? ""}`,
  ];
  // systemctl omits EnvironmentFiles entirely when the effective array is empty.
  if (overrides.EnvironmentFiles !== undefined) lines.push(`EnvironmentFiles=${overrides.EnvironmentFiles}`);
  return `${lines.join("\n")}\n`;
}

function systemdDefinition(configPath?: string): string {
  const escapedConfigPath = configPath
    ?.replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  const environment = escapedConfigPath === undefined
    ? ""
    : `Environment="PI_WEB_CONFIG=${escapedConfigPath}"\n`;
  return `[Service]\n${environment}ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"\n`;
}

function systemdDefinitionWithEnvironment(
  configPath: string | undefined,
  assignments: readonly string[],
): string {
  const directives = assignments.map((assignment) => `Environment="${assignment}"\n`).join("");
  return systemdDefinition(configPath).replace("[Service]\n", `[Service]\n${directives}`);
}

function busctlStringArray(values: readonly string[]): string {
  const serialized = values.map((value) => JSON.stringify(value)).join(" ");
  return `as ${String(values.length)}${serialized === "" ? "" : ` ${serialized}`}\n`;
}

function launchdDefinition(configPath?: string): string {
  const environment = configPath === undefined
    ? ""
    : `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PI_WEB_CONFIG</key>\n    <string>${configPath}</string>\n  </dict>\n`;
  return `<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.pi-web.web</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/env</string>\n    <string>/bin/zsh</string>\n    <string>-lc</string>\n    <string>exec true</string>\n  </array>\n${environment}</dict>\n</plist>\n`;
}

function launchdPrint(
  path = launchdPath,
  configPath?: string,
): string {
  const config = configPath === undefined ? "" : `\t\tPI_WEB_CONFIG => ${configPath}\n`;
  return `${launchdTarget} = {
\tactive count = 1
\tpath = ${path}
\ttype = LaunchAgent
\tstate = running

\tprogram = /usr/bin/env
\targuments = {
\t\t/usr/bin/env
\t\t/bin/zsh
\t\t-lc
\t\texec true
\t}

\tenvironment = {
${config}\t\tXPC_SERVICE_NAME => com.pi-web.web
\t}

\tdomain = gui/501 [100004]
\tresource coalition = {
\t\tID = 123
\t\ttype = resource
\t\tstate = active
\t\tactive count = 1
\t\tname = com.pi-web.web
\t}

\tproperties = runatload | inferred program
}
`;
}

interface CommandResultFixture {
  status: number;
  stdout: string | Uint8Array;
  stderr: string | Uint8Array;
  spawnError?: string;
}

function commandResult(fixture: CommandResultFixture): InstalledNativeServiceDefinitionCommandResult {
  return {
    status: fixture.status,
    stdout: typeof fixture.stdout === "string" ? new TextEncoder().encode(fixture.stdout) : fixture.stdout,
    stderr: typeof fixture.stderr === "string" ? new TextEncoder().encode(fixture.stderr) : fixture.stderr,
    spawnError: fixture.spawnError ?? "",
  };
}

function dependencies(
  contents: Uint8Array = new TextEncoder().encode(systemdDefinition()),
  result: CommandResultFixture = { status: 0, stdout: managerOutput(), stderr: "" },
): InstalledNativeServiceDefinitionDependencies {
  const captured = commandResult(result);
  return {
    readFile: vi.fn(() => contents),
    realpath: vi.fn((path: string) => path),
    capture: vi.fn(() => captured),
  };
}

function legacySystemdDependencies(
  contents: string,
  busctlResult: CommandResultFixture,
  systemctlEnvironment = "[unprintable]",
): InstalledNativeServiceDefinitionDependencies {
  const systemctlResult = commandResult({
    status: 0,
    stdout: managerOutput({ Environment: systemctlEnvironment }),
    stderr: "",
  });
  const capturedBusctlResult = commandResult(busctlResult);
  const deps = dependencies(new TextEncoder().encode(contents), systemctlResult);
  vi.mocked(deps.capture).mockImplementation((command) => {
    if (command === "systemctl") return systemctlResult;
    if (command === "busctl") return capturedBusctlResult;
    throw new Error(`Unexpected command ${command}`);
  });
  return deps;
}

describe("installed native-service definition boundary", () => {
  it("binds a strict systemd fragment snapshot to modern quoted manager output", () => {
    const contents = `[Unit]\nDescription=é\n${systemdDefinition("/managed/$HOME/config with space.json")}`;
    const deps = dependencies(
      new TextEncoder().encode(contents),
      {
        status: 0,
        stdout: managerOutput({ Environment: '"PI_WEB_CONFIG=/managed/\\$HOME/config with space.json"' }),
        stderr: "",
      },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    )).toEqual({
      ok: true,
      value: [{ id: "web", contents }],
    });
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(deps.capture).toHaveBeenCalledWith("systemctl", [
      "--user",
      "--no-pager",
      "show",
      "pi-web-web.service",
      "--all",
      "--property=LoadState",
      "--property=FragmentPath",
      "--property=DropInPaths",
      "--property=NeedDaemonReload",
      "--property=EnvironmentFiles",
      "--property=Environment",
    ]);
  });

  it("matches a prototype-collision environment assignment across disk and manager snapshots", () => {
    const contents = systemdDefinitionWithEnvironment("/managed/config.json", ["__proto__=matching"]);
    const deps = dependencies(
      new TextEncoder().encode(contents),
      {
        status: 0,
        stdout: managerOutput({ Environment: "PI_WEB_CONFIG=/managed/config.json __proto__=matching" }),
        stderr: "",
      },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
  });

  it.each([
    {
      name: "only on disk",
      diskAssignments: ["__proto__=disk"],
      managerEnvironment: "PI_WEB_CONFIG=/managed/config.json",
    },
    {
      name: "only in the manager",
      diskAssignments: [],
      managerEnvironment: "PI_WEB_CONFIG=/managed/config.json __proto__=manager",
    },
    {
      name: "with conflicting values",
      diskAssignments: ["__proto__=disk"],
      managerEnvironment: "PI_WEB_CONFIG=/managed/config.json __proto__=manager",
    },
  ])("fails closed when a prototype-collision environment assignment exists $name", ({
    diskAssignments,
    managerEnvironment,
  }) => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(
        new TextEncoder().encode(systemdDefinitionWithEnvironment("/managed/config.json", diskAssignments)),
        { status: 0, stdout: managerOutput({ Environment: managerEnvironment }), stderr: "" },
      ),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected prototype-collision environment mismatch to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
  });

  it("rejects a duplicate prototype-collision assignment in the effective manager environment", () => {
    const contents = systemdDefinitionWithEnvironment("/managed/config.json", ["__proto__=matching"]);
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(
        new TextEncoder().encode(contents),
        {
          status: 0,
          stdout: managerOutput({
            Environment: "PI_WEB_CONFIG=/managed/config.json __proto__=matching __proto__=matching",
          }),
          stderr: "",
        },
      ),
      "restart",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected duplicate manager environment assignment to fail");
    expect(result.message).toContain("unrecognized Environment");
  });

  it("recovers a legacy systemd [unprintable] environment losslessly from D-Bus", () => {
    const configPath = "/managed/é config with space.json";
    const contents = systemdDefinition(configPath);
    const deps = legacySystemdDependencies(contents, {
      status: 0,
      stdout: 'as 1 "PI_WEB_CONFIG=/managed/\\303\\251 config with space.json"\n',
      stderr: "",
    });

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(2, "busctl", [
      "--user",
      "get-property",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1/unit/pi_2dweb_2dweb_2eservice",
      "org.freedesktop.systemd1.Service",
      "Environment",
    ]);
  });

  it.each([
    {
      name: "apostrophe",
      configPath: "/managed/o'brien/config.json",
      systemctlEnvironment: "PI_WEB_CONFIG=/managed/o'brien/config.json",
    },
    {
      name: "double quote",
      configPath: '/managed/"quoted"/config.json',
      systemctlEnvironment: 'PI_WEB_CONFIG=/managed/"quoted"/config.json',
    },
    {
      name: "backslash",
      configPath: String.raw`/managed/back\slash/config.json`,
      systemctlEnvironment: String.raw`PI_WEB_CONFIG=/managed/back\slash/config.json`,
    },
    {
      name: "tab",
      configPath: "/managed/with\ttab/config.json",
      systemctlEnvironment: "PI_WEB_CONFIG=/managed/with\ttab/config.json",
    },
  ])("recovers a legacy systemd environment containing a raw $name", ({ configPath, systemctlEnvironment }) => {
    const contents = systemdDefinition(configPath);
    const deps = legacySystemdDependencies(
      contents,
      { status: 0, stdout: busctlStringArray([`PI_WEB_CONFIG=${configPath}`]), stderr: "" },
      systemctlEnvironment,
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "restart",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    expect(deps.capture).toHaveBeenCalledTimes(2);
  });

  it("recovers a matching legacy systemd environment ending in a raw carriage return", () => {
    const configPath = "/config/managed.json\r";
    const contents = systemdDefinition(configPath);
    const deps = legacySystemdDependencies(
      contents,
      { status: 0, stdout: busctlStringArray([`PI_WEB_CONFIG=${configPath}`]), stderr: "" },
      `PI_WEB_CONFIG=${configPath}`,
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(2, "busctl", expect.any(Array));
  });

  it("fails closed when a legacy systemd environment ending in a raw carriage return differs from disk", () => {
    const diskConfigPath = "/config/managed.json";
    const managerConfigPath = `${diskConfigPath}\r`;
    const deps = legacySystemdDependencies(
      systemdDefinition(diskConfigPath),
      { status: 0, stdout: busctlStringArray([`PI_WEB_CONFIG=${managerConfigPath}`]), stderr: "" },
      `PI_WEB_CONFIG=${managerConfigPath}`,
    );

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected trailing-carriage-return manager mismatch to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
    expect(deps.capture).toHaveBeenCalledTimes(2);
    expect(deps.capture).toHaveBeenNthCalledWith(2, "busctl", expect.any(Array));
  });

  it("fails closed when legacy systemd's lossless environment differs from disk", () => {
    const deps = legacySystemdDependencies(systemdDefinition("/config/a with space.json"), {
      status: 0,
      stdout: 'as 1 "PI_WEB_CONFIG=/config/b with space.json"\n',
      stderr: "",
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected legacy systemd environment mismatch to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
  });

  it("surfaces a failed lossless legacy systemd environment query", () => {
    const deps = legacySystemdDependencies(systemdDefinition("/config/with space.json"), {
      status: 127,
      stdout: "",
      stderr: "busctl: command not found",
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failed busctl inspection to fail");
    expect(result.message).toContain("losslessly");
    expect(result.message).toContain("[unprintable]");
    expect(result.message).toContain("busctl: command not found");
  });

  it("rejects malformed lossless legacy systemd environment output", () => {
    const deps = legacySystemdDependencies(systemdDefinition("/config/with space.json"), {
      status: 0,
      stdout: 'as 2 "PI_WEB_CONFIG=/config/with space.json"\n',
      stderr: "",
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected malformed busctl environment to fail");
    expect(result.message).toContain("busctl returned an unrecognized Environment");
  });

  it.each([
    [
      "drop-ins",
      managerOutput({ DropInPaths: "/home/user/.config/systemd/user/pi-web-web.service.d/override.conf" }),
      "effective drop-ins",
    ],
    [
      "environment files",
      managerOutput({ EnvironmentFiles: "/home/user/pi-web.env (ignore_errors=no)" }),
      "EnvironmentFile inputs",
    ],
    ["stale manager state", managerOutput({ NeedDaemonReload: "yes" }), "daemon-reload"],
    ["another fragment", managerOutput({ FragmentPath: "/usr/lib/systemd/user/pi-web-web.service" }), "instead of"],
  ])("fails closed for systemd %s", (_name, output, expectedMessage) => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(undefined, { status: 0, stdout: output, stderr: "" }),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected effective systemd inspection to fail");
    expect(result.message).toContain(expectedMessage);
  });

  it("rejects a read/reload interleaving whose manager environment belongs to another snapshot", () => {
    let snapshotRead = false;
    const deps = dependencies(new TextEncoder().encode(systemdDefinition("/config/a.json")));
    vi.mocked(deps.readFile).mockImplementation(() => {
      snapshotRead = true;
      return new TextEncoder().encode(systemdDefinition("/config/a.json"));
    });
    vi.mocked(deps.capture).mockImplementation(() => {
      expect(snapshotRead).toBe(true);
      return commandResult({
        status: 0,
        stdout: managerOutput({ Environment: "PI_WEB_CONFIG=/config/b.json" }),
        stderr: "",
      });
    });

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected interleaved systemd snapshots to fail");
    expect(result.message).toContain("effective environment");
    expect(result.message).toContain("differs");
  });

  it("rejects malformed systemctl environment serialization", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      dependencies(undefined, {
        status: 0,
        stdout: managerOutput({ Environment: '"PI_WEB_CONFIG=/unterminated' }),
        stderr: "",
      }),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected malformed manager environment to fail");
    expect(result.message).toContain("unrecognized Environment");
  });

  it("surfaces a failed systemd manager inspection after taking a strict fragment snapshot", () => {
    const deps = dependencies();
    vi.mocked(deps.capture).mockReturnValue(commandResult({
      status: 1,
      stdout: "",
      stderr: "Failed to connect to bus",
    }));

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "systemd", label: "systemd" },
      [source],
      deps,
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected manager inspection failure");
    expect(result.message).toContain("Failed to connect to bus");
    expect(deps.readFile).toHaveBeenCalledWith(servicePath);
  });

  it.each(["systemd", "launchd"] as const)("rejects malformed UTF-8 bytes in %s definitions", (kind) => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind, label: kind },
      [source],
      dependencies(Uint8Array.from([0x5b, 0x53, 0xff, 0x5d])),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected strict UTF-8 decoding to fail");
    expect(result.message).toContain("not valid UTF-8");
  });

  it("accepts an unloaded LaunchAgent that start can bootstrap from the inspected plist", () => {
    const launchdSource = { ...source, path: launchdPath };
    const deps = dependencies(
      new TextEncoder().encode(launchdDefinition("/managed/config.json")),
      {
        status: 113,
        stdout: "",
        stderr: `Could not find service "com.pi-web.web" in domain for user gui: 501`,
      },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [launchdSource],
      deps,
      "start",
    )).toMatchObject({ ok: true });
    expect(deps.capture).toHaveBeenCalledWith("launchctl", ["print", launchdTarget]);
  });

  it("consumes an ordinary loaded LaunchAgent representation and binds its plist and config", () => {
    const contents = launchdDefinition("/managed/config with space.json");
    const deps = dependencies(
      new TextEncoder().encode(contents),
      { status: 0, stdout: launchdPrint(launchdPath, "/managed/config with space.json"), stderr: "" },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      deps,
      "doctor",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });
  });

  it.each([
    ["2028", "\u2028"],
    ["2029", "\u2029"],
  ])(
    "preserves U+%s in matching loaded LaunchAgent paths and config values",
    (_codePoint, separator) => {
      const path = `/Users/user/Library/LaunchAgents/com.pi-web${separator}web.plist`;
      const configPath = `/managed/config${separator}value.json`;
      const contents = launchdDefinition(configPath);

      expect(inspectInstalledNativeServiceDefinitions(
        { kind: "launchd", label: "launchd" },
        [{ ...source, path }],
        dependencies(
          new TextEncoder().encode(contents),
          { status: 0, stdout: launchdPrint(path, configPath), stderr: "" },
        ),
        "doctor",
      )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    },
  );

  it.each([
    ["group-opening marker", " = {"],
    ["literal U+FFFD", "\uFFFD"],
  ])(
    "preserves a %s at the end of matching loaded LaunchAgent scalar values",
    (_name, suffix) => {
      const path = `/Users/user/Library/LaunchAgents/com.pi-web.web.plist${suffix}`;
      const configPath = `/managed/config.json${suffix}`;
      const contents = launchdDefinition(configPath);

      expect(inspectInstalledNativeServiceDefinitions(
        { kind: "launchd", label: "launchd" },
        [{ ...source, path }],
        dependencies(
          new TextEncoder().encode(contents),
          { status: 0, stdout: launchdPrint(path, configPath), stderr: "" },
        ),
        "doctor",
      )).toEqual({ ok: true, value: [{ id: "web", contents }] });
    },
  );

  it("rejects malformed UTF-8 bytes in launchctl output", () => {
    const configPath = "/managed/config.json";
    const printed = launchdPrint(launchdPath, configPath);
    const malformedOutput = new TextEncoder().encode(printed);
    const configOffset = printed.indexOf(configPath);
    if (configOffset < 0) throw new Error("Expected config path in launchctl fixture");
    malformedOutput[configOffset] = 0xff;

    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition(configPath)),
        { status: 0, stdout: malformedOutput, stderr: "" },
      ),
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected malformed launchctl UTF-8 to fail");
    expect(result.message).toContain("launchctl output is not valid UTF-8");
  });

  it.each(["plist path", "managed environment", "document trailer"] as const)(
    "rejects an ambiguous carriage return in the launchctl %s",
    (location) => {
      const configPath = "/managed/config.json";
      let stdout = launchdPrint(launchdPath, configPath);
      if (location === "plist path") {
        stdout = stdout.replace(`\tpath = ${launchdPath}\n`, `\tpath = ${launchdPath}\r\n`);
      } else if (location === "managed environment") {
        stdout = stdout.replace(
          `\t\tPI_WEB_CONFIG => ${configPath}\n`,
          `\t\tPI_WEB_CONFIG => ${configPath}\r\n`,
        );
      } else {
        stdout = `${stdout.slice(0, -1)}\r`;
      }

      const result = inspectInstalledNativeServiceDefinitions(
        { kind: "launchd", label: "launchd" },
        [{ ...source, path: launchdPath }],
        dependencies(
          new TextEncoder().encode(launchdDefinition(configPath)),
          { status: 0, stdout, stderr: "" },
        ),
        "doctor",
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected ambiguous launchctl framing to fail");
      expect(result.message).toContain("unrecognized service definition");
    },
  );

  it.each([
    {
      name: "truncated after the environment dictionary",
      output: (complete: string): string => {
        const remainingStateOffset = complete.indexOf("\n\n\tdomain =");
        if (remainingStateOffset < 0) throw new Error("Expected ordinary launchctl state after environment");
        return complete.slice(0, remainingStateOffset);
      },
    },
    {
      name: "closed before conflicting remaining environment state",
      output: (complete: string): string => complete.replace(
        "\t}\n\n\tdomain =",
        "\t}\n}\n\t\tPI_WEB_CONFIG => /managed/conflicting.json\n\t}\n\n\tdomain =",
      ),
    },
    {
      name: "followed by unconsumed trailing state",
      output: (complete: string): string => `${complete}\tPI_WEB_CONFIG => /managed/conflicting.json\n}\n`,
    },
  ])("rejects launchctl output $name", ({ output }) => {
    const configPath = "/managed/config.json";
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition(configPath)),
        { status: 0, stdout: output(launchdPrint(launchdPath, configPath)), stderr: "" },
      ),
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected incomplete launchctl representation to fail");
    expect(result.message).toContain("unrecognized service definition");
  });

  it("requires the loaded LaunchAgent config to be an own environment entry", () => {
    const contents = launchdDefinition("/managed/config.json");
    const deps = dependencies(
      new TextEncoder().encode(contents),
      { status: 0, stdout: launchdPrint(launchdPath), stderr: "" },
    );
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "PI_WEB_CONFIG");
    Object.defineProperty(Object.prototype, "PI_WEB_CONFIG", {
      configurable: true,
      value: "/managed/config.json",
    });

    try {
      const result = inspectInstalledNativeServiceDefinitions(
        { kind: "launchd", label: "launchd" },
        [{ ...source, path: launchdPath }],
        deps,
        "doctor",
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected inherited loaded config to fail");
      expect(result.message).toContain("PI_WEB_CONFIG undefined");
      expect(result.message).toContain("/managed/config.json");
    } finally {
      if (previousDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "PI_WEB_CONFIG");
      } else {
        Object.defineProperty(Object.prototype, "PI_WEB_CONFIG", previousDescriptor);
      }
    }
  });

  it("accepts one prototype-collision launchd entry but rejects duplicates", () => {
    const contents = launchdDefinition("/managed/config.json");
    const xpcEntry = "\t\tXPC_SERVICE_NAME => com.pi-web.web\n";
    const withPrototypeEntries = (entries: string): string => launchdPrint(
      launchdPath,
      "/managed/config.json",
    ).replace(xpcEntry, `${entries}${xpcEntry}`);

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(contents),
        { status: 0, stdout: withPrototypeEntries("\t\t__proto__ => once\n"), stderr: "" },
      ),
      "doctor",
    )).toEqual({ ok: true, value: [{ id: "web", contents }] });

    const duplicate = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(contents),
        {
          status: 0,
          stdout: withPrototypeEntries("\t\t__proto__ => first\n\t\t__proto__ => second\n"),
          stderr: "",
        },
      ),
      "doctor",
    );

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("Expected duplicate prototype-collision launchd entries to fail");
    expect(duplicate.message).toContain("unrecognized service definition");
  });

  it("rejects a LaunchAgent loaded from another plist", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition("/managed/config.json")),
        {
          status: 0,
          stdout: launchdPrint("/Library/LaunchAgents/com.pi-web.web.plist", "/managed/config.json"),
          stderr: "",
        },
      ),
      "start",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a foreign loaded plist to fail");
    expect(result.message).toContain("instead of the installed PI WEB definition");
    expect(result.message).toContain("pi-web restart");
  });

  it("rejects stale loaded LaunchAgent config even when the plist path still matches", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition("/config/new.json")),
        { status: 0, stdout: launchdPrint(launchdPath, "/config/old.json"), stderr: "" },
      ),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected stale loaded config to fail");
    expect(result.message).toContain("PI_WEB_CONFIG");
    expect(result.message).toContain("/config/old.json");
    expect(result.message).toContain("/config/new.json");
  });

  it("lets launchd restart inspect disk while its bootout/bootstrap path repairs stale loaded state", () => {
    const deps = dependencies(
      new TextEncoder().encode(launchdDefinition("/config/new.json")),
      { status: 0, stdout: launchdPrint("/another/path.plist", "/config/old.json"), stderr: "" },
    );

    expect(inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      deps,
      "restart",
    )).toMatchObject({ ok: true });
    expect(deps.capture).not.toHaveBeenCalled();
  });

  it("surfaces launchctl inspection errors instead of treating every failure as unloaded", () => {
    const result = inspectInstalledNativeServiceDefinitions(
      { kind: "launchd", label: "launchd" },
      [{ ...source, path: launchdPath }],
      dependencies(
        new TextEncoder().encode(launchdDefinition()),
        { status: 1, stdout: "", stderr: "Operation not permitted" },
      ),
      "doctor",
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected launchctl inspection error");
    expect(result.message).toContain("Operation not permitted");
  });
});
