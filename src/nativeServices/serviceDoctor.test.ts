import { describe, expect, it } from "vitest";
import {
  formatNativeServiceDoctorResult,
  inferInstalledNativeServiceMode,
  inspectInstalledDevelopmentServiceInput,
  inspectInstalledNativeServiceDefinitionEnvironment,
  inspectInstalledProductionServiceContext,
  runNativeServiceDoctor,
  selectManagedNativeServiceConfig,
  type InstalledNativeServiceDefinition,
  type NativeServiceDoctorTarget,
} from "./serviceDoctor.js";
import {
  createDevelopmentNativeServicePlan,
  resolveProductionNativeServicePlan,
  type NativeServiceAuthoritativeProbe,
  type NativeServicePlan,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";
import { renderLaunchdPlist, renderSystemdUnit } from "./serviceRendering.js";

const shell = {
  name: "zsh",
  executable: "/bin/zsh",
  source: "detected",
  detectedExecutable: "/bin/zsh",
} as const;

function productionInput(configured = false): ProductionNativeServicePlanInput {
  return {
    backend: { kind: "systemd", label: "systemd user services" },
    shell,
    environment: { PI_WEB_CONFIG: "/home/user/config.json" },
    executables: {
      sessiond: {
        configuredCommand: configured ? "custom sessiond --flag" : undefined,
        namedCommand: "pi-web-sessiond",
        bundledEntrypointPath: "/package/sessiond.js",
      },
      web: {
        configuredCommand: configured ? "custom web --flag" : undefined,
        namedCommand: "pi-web-server",
        bundledEntrypointPath: "/package/server.js",
      },
    },
  };
}

function probeWithStatus(status: "satisfied" | "unsatisfied"): NativeServiceAuthoritativeProbe {
  return {
    run: (request) => Promise.resolve({
      kind: "completed",
      outcomes: request.prerequisites.map((prerequisite) => ({
        prerequisiteId: prerequisite.id,
        status,
        detail: status === "satisfied" ? null : `${prerequisite.id} missing in manager context`,
      })),
    }),
  };
}

function developmentPlan(
  kind: "systemd" | "launchd",
  configPath: string | null = "/home/user/config & dev.json",
): NativeServicePlan {
  return createDevelopmentNativeServicePlan({
    backend: { kind, label: kind },
    shell,
    environment: configPath === null ? {} : { PI_WEB_CONFIG: configPath },
    workingDirectory: "/checkout with space",
    packageJsonPath: "/checkout with space/package.json",
  });
}

async function productionPlan(kind: "systemd" | "launchd"): Promise<NativeServicePlan> {
  const resolution = await resolveProductionNativeServicePlan(
    {
      ...productionInput(true),
      backend: { kind, label: kind },
    },
    { probe: probeWithStatus("satisfied"), fileExists: () => true },
  );
  if (!resolution.ok) throw new Error("Expected configured production plan to resolve");
  return resolution.plan;
}

function renderedDefinitions(plan: NativeServicePlan): InstalledNativeServiceDefinition[] {
  return plan.services.map((service) => ({
    id: service.id,
    contents: plan.backend.kind === "systemd"
      ? renderSystemdUnit(plan, service)
      : renderLaunchdPlist(plan, service, "/tmp/logs"),
  }));
}

const launchdProgramArgumentsEntry = `  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>exec pi-web-sessiond</string>
  </array>
`;
const launchdEnvironmentEntry = `  <key>EnvironmentVariables</key>
  <dict>
    <key>PI_WEB_CONFIG</key>
    <string>/foreign.json</string>
  </dict>
`;

function launchdManagedConfigEntries(label: string | null, programArguments = launchdProgramArgumentsEntry): string {
  const labelEntry = label === null ? "" : `  <key>Label</key>\n  <string>${label}</string>\n`;
  return `${labelEntry}${programArguments}${launchdEnvironmentEntry}`;
}

function launchdPlistDocument(entries: string): string {
  return `<plist version="1.0">\n<dict>\n${entries}</dict>\n</plist>\n`;
}

describe("installed native-service mode and definition inspection", () => {
  it("infers production, development, absent, and ambiguous service sets", () => {
    expect(inferInstalledNativeServiceMode(new Set())).toBe("none");
    expect(inferInstalledNativeServiceMode(new Set(["sessiond", "web"]))).toBe("production");
    expect(inferInstalledNativeServiceMode(new Set(["sessiond", "uiDev"]))).toBe("development");
    expect(inferInstalledNativeServiceMode(new Set(["web", "uiDev"]))).toBe("ambiguous");
    expect(inferInstalledNativeServiceMode(new Set(["sessiond"]))).toBe("ambiguous");
  });

  it.each(["systemd", "launchd"] as const)("selects persisted config from %s production definitions", async (kind) => {
    const plan = await productionPlan(kind);

    expect(selectManagedNativeServiceConfig(plan.backend, renderedDefinitions(plan), undefined)).toEqual({
      ok: true,
      value: { source: "installed", configPath: "/home/user/config.json" },
    });
  });

  it.each(["systemd", "launchd"] as const)("selects persisted config from %s development definitions", (kind) => {
    const plan = developmentPlan(kind);

    expect(selectManagedNativeServiceConfig(plan.backend, renderedDefinitions(plan), "")).toEqual({
      ok: true,
      value: { source: "installed", configPath: "/home/user/config & dev.json" },
    });
  });

  it("normalizes LaunchAgent XML line endings before selecting persisted config", () => {
    const plan = developmentPlan("launchd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replaceAll("\n", "\r\n"),
    }));

    expect(selectManagedNativeServiceConfig(plan.backend, definitions, undefined)).toEqual({
      ok: true,
      value: { source: "installed", configPath: "/home/user/config & dev.json" },
    });
  });

  it.each(["systemd", "launchd"] as const)("lets a nonempty caller config override malformed %s definitions", (kind) => {
    const backend = { kind, label: kind };
    const malformed: InstalledNativeServiceDefinition[] = [{ id: "web", contents: "not a service definition" }];

    expect(selectManagedNativeServiceConfig(backend, malformed, "/caller/config.json")).toEqual({
      ok: true,
      value: { source: "caller", configPath: "/caller/config.json" },
    });
    expect(selectManagedNativeServiceConfig(backend, malformed, "caller/config.json")).toEqual({
      ok: true,
      value: { source: "caller", configPath: "caller/config.json" },
    });
  });

  it.each(["systemd", "launchd"] as const)("keeps default config semantics when %s definitions persist no path", (kind) => {
    const plan = developmentPlan(kind, null);

    expect(selectManagedNativeServiceConfig(plan.backend, renderedDefinitions(plan), undefined)).toEqual({
      ok: true,
      value: { source: "default" },
    });
    expect(selectManagedNativeServiceConfig(plan.backend, [], undefined)).toEqual({
      ok: true,
      value: { source: "default" },
    });
  });

  it.each(["systemd", "launchd"] as const)("ignores inherited config while selecting from %s definitions", (kind) => {
    const plan = developmentPlan(kind, null);
    const definitions = renderedDefinitions(plan);
    const previousDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "PI_WEB_CONFIG");
    Object.defineProperty(Object.prototype, "PI_WEB_CONFIG", {
      configurable: true,
      value: "/inherited/config.json",
    });

    try {
      expect(selectManagedNativeServiceConfig(plan.backend, definitions, undefined)).toEqual({
        ok: true,
        value: { source: "default" },
      });
    } finally {
      if (previousDescriptor === undefined) {
        Reflect.deleteProperty(Object.prototype, "PI_WEB_CONFIG");
      } else {
        Object.defineProperty(Object.prototype, "PI_WEB_CONFIG", previousDescriptor);
      }
    }
  });

  it.each(["systemd", "launchd"] as const)("rejects a relative config recovered from %s definitions", (kind) => {
    const plan = developmentPlan(kind, "config/managed.json");
    const selection = selectManagedNativeServiceConfig(plan.backend, renderedDefinitions(plan), undefined);

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected relative managed config selection to fail");
    expect(selection.message).toContain("relative PI_WEB_CONFIG");
    expect(selection.message).toContain("must be absolute");
  });

  it.each(["systemd", "launchd"] as const)("rejects conflicting config in %s definitions", (kind) => {
    const first = renderedDefinitions(developmentPlan(kind, "/config/one.json"))[0];
    const second = renderedDefinitions(developmentPlan(kind, "/config/two.json"))[1];
    if (first === undefined || second === undefined) throw new Error("Expected two rendered definitions");

    const selection = selectManagedNativeServiceConfig(
      { kind, label: kind },
      [first, second],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected inconsistent definitions to fail selection");
    expect(selection.message).toContain("different environments");
  });

  it.each(["systemd", "launchd"] as const)("rejects malformed %s definitions when no caller override exists", (kind) => {
    const selection = selectManagedNativeServiceConfig(
      { kind, label: kind },
      [{ id: "web", contents: "not a service definition" }],
      undefined,
    );

    expect(selection.ok).toBe(false);
  });

  it("rejects systemd physical-line continuation before selecting its apparent environment", () => {
    const contents = `[Service]\nType=simple\\\nEnvironment="PI_WEB_CONFIG=/foreign.json"\nExecStart=/usr/bin/env "/bin/zsh" -lc "exec pi-web-sessiond"\nRestart=no\n`;
    const selection = selectManagedNativeServiceConfig(
      { kind: "systemd", label: "systemd" },
      [{ id: "sessiond", contents }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected continued systemd definition selection to fail");
    expect(selection.message).toContain("physical-line continuation");
  });

  it.each([
    ["bare regex-shaped fragment", launchdManagedConfigEntries("com.pi-web.sessiond")],
    [
      "truncated plist",
      `<plist version="1.0">\n<dict>\n${launchdManagedConfigEntries("com.pi-web.sessiond")}`,
    ],
  ])("rejects a %s before it can supply managed config", (_name, contents) => {
    const selection = selectManagedNativeServiceConfig(
      { kind: "launchd", label: "launchd" },
      [{ id: "sessiond", contents }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected malformed LaunchAgent selection to fail");
    expect(selection.message).toContain("structurally valid property list");
  });

  it.each([
    ["missing", null, "unrecognized Label"],
    ["mismatched", "com.pi-web.web", "declares Label"],
  ])("rejects a %s LaunchAgent service label", (_name, label, expectedMessage) => {
    const selection = selectManagedNativeServiceConfig(
      { kind: "launchd", label: "launchd" },
      [{ id: "sessiond", contents: launchdPlistDocument(launchdManagedConfigEntries(label)) }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected misidentified LaunchAgent selection to fail");
    expect(selection.message).toContain(expectedMessage);
  });

  it("rejects duplicate LaunchAgent ProgramArguments keys", () => {
    const entries = launchdManagedConfigEntries(
      "com.pi-web.sessiond",
      `${launchdProgramArgumentsEntry}${launchdProgramArgumentsEntry}`,
    );
    const selection = selectManagedNativeServiceConfig(
      { kind: "launchd", label: "launchd" },
      [{ id: "sessiond", contents: launchdPlistDocument(entries) }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected duplicate LaunchAgent key selection to fail");
    expect(selection.message).toContain("structurally valid property list");
  });

  it.each([
    ["NUL", "\u0000"],
    ["U+0001", "\u0001"],
  ])("rejects XML-illegal %s content in a LaunchAgent", (_name, control) => {
    const entries = launchdManagedConfigEntries("com.pi-web.sessiond")
      .replace("/foreign.json", `/foreign${control}.json`);
    const selection = selectManagedNativeServiceConfig(
      { kind: "launchd", label: "launchd" },
      [{ id: "sessiond", contents: launchdPlistDocument(entries) }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected XML-illegal LaunchAgent selection to fail");
    expect(selection.message).toContain("structurally valid property list");
  });

  it.each([
    ["data", "not-base64"],
    ["date", "2026-13-01T00:00:00Z"],
    ["integer", "not-an-integer"],
    ["real", "not-a-real"],
  ] as const)("rejects malformed LaunchAgent <%s> scalar content", (tag, value) => {
    const malformedScalar = `  <key>IgnoredMalformedValue</key>\n  <${tag}>${value}</${tag}>\n`;
    const entries = `${launchdManagedConfigEntries("com.pi-web.sessiond")}${malformedScalar}`;
    const selection = selectManagedNativeServiceConfig(
      { kind: "launchd", label: "launchd" },
      [{ id: "sessiond", contents: launchdPlistDocument(entries) }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected malformed scalar LaunchAgent selection to fail");
    expect(selection.message).toContain("structurally valid property list");
  });

  it.each(["systemd", "launchd"] as const)("reconstructs POSIX development paths from %s definitions on every host", (kind) => {
    const plan = developmentPlan(kind);
    expect(inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan))).toEqual({
      ok: true,
      value: {
        backend: plan.backend,
        shell,
        environment: { PI_WEB_CONFIG: "/home/user/config & dev.json" },
        workingDirectory: "/checkout with space",
        packageJsonPath: "/checkout with space/package.json",
      },
    });
  });

  it("rejects a truncated quoted systemd environment within bounded parser time", () => {
    // This finite payload took seconds with the ambiguous escaped/raw regex alternatives.
    const contents = [
      "[Service]",
      `Environment="${"\\".repeat(40)}`,
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n");

    const startedAt = performance.now();
    const inspection = inspectInstalledNativeServiceDefinitionEnvironment(
      { kind: "systemd", label: "systemd" },
      { id: "web", contents },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected truncated environment inspection to fail");
    expect(inspection.message).toContain("unrecognized environment entry");
    expect(elapsedMs).toBeLessThan(500);
  });

  it.each([
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ] as const)("round-trips rendered systemd config paths containing a %s", (_label, separator) => {
    const configPath = `/home/user/config${separator}name.json`;
    const plan = developmentPlan("systemd", configPath);

    expect(selectManagedNativeServiceConfig(plan.backend, renderedDefinitions(plan), undefined)).toEqual({
      ok: true,
      value: { source: "installed", configPath },
    });
  });

  it("round-trips a rendered systemd shell path containing the login-shell delimiter", () => {
    const delimiterShell = {
      ...shell,
      executable: "/opt/contains -lc /zsh",
      detectedExecutable: "/opt/contains -lc /zsh",
    };
    const plan = createDevelopmentNativeServicePlan({
      backend: { kind: "systemd", label: "systemd" },
      shell: delimiterShell,
      environment: { PI_WEB_CONFIG: "/home/user/config.json" },
      workingDirectory: "/checkout",
      packageJsonPath: "/checkout/package.json",
    });

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan))).toEqual({
      ok: true,
      value: {
        backend: plan.backend,
        shell: delimiterShell,
        environment: { PI_WEB_CONFIG: "/home/user/config.json" },
        workingDirectory: "/checkout",
        packageJsonPath: "/checkout/package.json",
      },
    });
  });

  it.each([
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
  ] as const)("round-trips rendered systemd shell and command values containing a %s", async (_label, separator) => {
    const original = await productionPlan("systemd");
    const separatorShell = {
      ...shell,
      executable: `/opt/shell${separator}directory/zsh`,
      detectedExecutable: `/opt/shell${separator}directory/zsh`,
    };
    const plan: NativeServicePlan = {
      ...original,
      shell: separatorShell,
      services: original.services.map((service) => ({
        ...service,
        shellCommand: `${service.shellCommand}${separator}tail`,
      })),
    };

    expect(inspectInstalledProductionServiceContext(plan.backend, renderedDefinitions(plan))).toEqual({
      ok: true,
      value: {
        shell: separatorShell,
        environment: { PI_WEB_CONFIG: "/home/user/config.json" },
      },
    });
  });

  it("reconstructs escaped systemd paths, substitutions, and line controls exactly", () => {
    const plan = createDevelopmentNativeServicePlan({
      backend: { kind: "systemd", label: "systemd" },
      shell: {
        name: "zsh",
        executable: "/shell $HOME/%h/zsh",
        source: "detected",
        detectedExecutable: "/shell $HOME/%h/zsh",
      },
      environment: { PI_WEB_CONFIG: "/config/%h\nnext" },
      workingDirectory: "/checkout %h\nnext",
      packageJsonPath: "/checkout %h\nnext/package.json",
    });

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan))).toEqual({
      ok: true,
      value: {
        backend: plan.backend,
        shell: plan.shell,
        environment: plan.services[0]?.environment,
        workingDirectory: "/checkout %h\nnext",
        packageJsonPath: "/checkout %h\nnext/package.json",
      },
    });
  });

  it("stores a prototype-collision systemd environment name as an own data property", () => {
    const inspection = inspectInstalledNativeServiceDefinitionEnvironment(
      { kind: "systemd", label: "systemd" },
      {
        id: "web",
        contents: [
          "[Service]",
          'Environment="__proto__=installed"',
          'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
        ].join("\n"),
      },
    );

    expect(inspection.ok).toBe(true);
    if (!inspection.ok) throw new Error("Expected prototype-collision environment name to parse");
    expect(Object.getOwnPropertyDescriptor(inspection.value, "__proto__")).toEqual({
      configurable: true,
      enumerable: true,
      value: "installed",
      writable: true,
    });
  });

  it("rejects a duplicate prototype-collision systemd environment name", () => {
    const inspection = inspectInstalledNativeServiceDefinitionEnvironment(
      { kind: "systemd", label: "systemd" },
      {
        id: "web",
        contents: [
          "[Service]",
          'Environment="__proto__=first"',
          'Environment="__proto__=second"',
          'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
        ].join("\n"),
      },
    );

    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected duplicate prototype-collision environment name to fail");
    expect(inspection.message).toContain("malformed environment entry");
  });

  it("decodes systemd hexadecimal escapes as UTF-8 bytes", () => {
    const contents = [
      "[Service]",
      'Environment="PI_WEB_CONFIG=/tmp/\\xC3\\xA9.json"',
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n");

    expect(selectManagedNativeServiceConfig(
      { kind: "systemd", label: "systemd" },
      [{ id: "web", contents }],
      undefined,
    )).toEqual({
      ok: true,
      value: { source: "installed", configPath: "/tmp/é.json" },
    });
  });

  it("rejects systemd hexadecimal escapes that do not form valid UTF-8", () => {
    const contents = [
      "[Service]",
      'Environment="PI_WEB_CONFIG=/tmp/\\xC3\\x28.json"',
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n");
    const selection = selectManagedNativeServiceConfig(
      { kind: "systemd", label: "systemd" },
      [{ id: "web", contents }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected invalid escaped UTF-8 to fail");
    expect(selection.message).toContain("environment entry");
  });

  it("preserves an escaped UTF-8 BOM so it cannot turn into the PI_WEB_CONFIG key", () => {
    const contents = [
      "[Service]",
      'Environment="\\xEF\\xBB\\xBFPI_WEB_CONFIG=/foreign.json"',
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n");
    const selection = selectManagedNativeServiceConfig(
      { kind: "systemd", label: "systemd" },
      [{ id: "web", contents }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected a BOM-prefixed environment key to fail");
    expect(selection.message).toContain("malformed environment entry");
  });

  it("uses systemd ASCII whitespace rules before service directives", () => {
    const asciiIndented = [
      "[Service]",
      '\tEnvironment="PI_WEB_CONFIG=/managed.json"',
      '\tExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"',
    ].join("\n");
    expect(selectManagedNativeServiceConfig(
      { kind: "systemd", label: "systemd" },
      [{ id: "web", contents: asciiIndented }],
      undefined,
    )).toEqual({ ok: true, value: { source: "installed", configPath: "/managed.json" } });

    const unicodeIndented = asciiIndented.replace("\tEnvironment", "\u00a0Environment");
    const selection = selectManagedNativeServiceConfig(
      { kind: "systemd", label: "systemd" },
      [{ id: "web", contents: unicodeIndented }],
      undefined,
    );

    expect(selection.ok).toBe(false);
    if (selection.ok) throw new Error("Expected Unicode-indented directive to fail");
    expect(selection.message).toContain("unrecognized service directives");
  });

  it("round-trips a rendered development working directory ending in a literal backslash", () => {
    const workingDirectory = "/checkout\\";
    const plan = createDevelopmentNativeServicePlan({
      backend: { kind: "systemd", label: "systemd" },
      shell,
      environment: { PI_WEB_CONFIG: "/home/user/config.json" },
      workingDirectory,
      packageJsonPath: `${workingDirectory}/package.json`,
    });

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan))).toMatchObject({
      ok: true,
      value: { workingDirectory, packageJsonPath: `${workingDirectory}/package.json` },
    });
  });

  it("interprets installed shell executable paths with POSIX semantics", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace('"/bin/zsh"', '"/bin/not-zsh\\\\zsh"'),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected the POSIX shell basename inspection to fail");
    expect(inspection.message).toContain("unsupported login shell");
  });

  it("inspects legacy systemd definitions without /usr/bin/env or quoted working directories", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents
        .replace("ExecStart=/usr/bin/env ", "ExecStart=")
        .replace("WorkingDirectory=/checkout\\x20with\\x20space", "WorkingDirectory=/checkout with space"),
    }));

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, definitions)).toMatchObject({
      ok: true,
      value: { workingDirectory: "/checkout with space" },
    });
  });

  it("continues to inspect legacy unquoted shells and shell-quoted commands", () => {
    const inspection = inspectInstalledNativeServiceDefinitionEnvironment(
      { kind: "systemd", label: "systemd" },
      {
        id: "web",
        contents: [
          "[Service]",
          'Environment="PI_WEB_CONFIG=/managed.json"',
          "ExecStart=/usr/bin/env /bin/zsh -lc 'exec true'",
        ].join("\n"),
      },
    );

    expect(inspection).toEqual({
      ok: true,
      value: { PI_WEB_CONFIG: "/managed.json" },
    });
  });

  it.each(["bash", "zsh", "fish"] as const)(
    "accepts raw dollars emitted by the pre-hardening %s systemd renderer",
    (shellName) => {
      const inspection = inspectInstalledNativeServiceDefinitionEnvironment(
        { kind: "systemd", label: "systemd" },
        {
          id: "web",
          contents: [
            "[Service]",
            'Environment="PI_WEB_CONFIG=/managed.json"',
            `ExecStart=/usr/bin/env /bin/${shellName} -lc 'exec echo $HOME %%h'`,
          ].join("\n"),
        },
      );

      expect(inspection).toEqual({
        ok: true,
        value: { PI_WEB_CONFIG: "/managed.json" },
      });
    },
  );

  it("continues to require doubled dollars in current double-quoted systemd commands", () => {
    const inspectCommand = (command: string) => inspectInstalledNativeServiceDefinitionEnvironment(
      { kind: "systemd", label: "systemd" },
      { id: "web", contents: ["[Service]", `ExecStart=/usr/bin/env "/bin/zsh" -lc ${command}`].join("\n") },
    );

    expect(inspectCommand('"exec echo $$HOME"')).toEqual({ ok: true, value: {} });
    const rawDollar = inspectCommand('"exec echo $HOME"');
    expect(rawDollar.ok).toBe(false);
    if (rawDollar.ok) throw new Error("Expected a raw dollar in a current ExecStart to fail");
    expect(rawDollar.message).toContain("unrecognized shell command");
  });

  it.each([
    [
      "unterminated command quote",
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true',
      "unrecognized shell command",
    ],
    [
      "trailing argument",
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true" trailing',
      "unrecognized shell command",
    ],
    [
      "concatenated command syntax",
      'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true""ignored"',
      "unrecognized shell command",
    ],
    [
      "noncanonical legacy command syntax",
      "ExecStart=/usr/bin/env /bin/zsh -lc 'exec true''ignored'",
      "unrecognized shell command",
    ],
    [
      "trailing syntax after a legacy raw-dollar command",
      "ExecStart=/usr/bin/env /bin/zsh -lc 'exec echo $HOME' trailing",
      "unrecognized shell command",
    ],
  ])("rejects %s in a systemd ExecStart", (_label, execStart, expectedMessage) => {
    const inspection = inspectInstalledNativeServiceDefinitionEnvironment(
      { kind: "systemd", label: "systemd" },
      { id: "web", contents: ["[Service]", execStart].join("\n") },
    );

    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected malformed ExecStart inspection to fail");
    expect(inspection.message).toContain(expectedMessage);
  });

  it("rejects quoted systemd working directories that the manager treats as non-absolute", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace(
        "WorkingDirectory=/checkout\\x20with\\x20space",
        'WorkingDirectory="/checkout with space"',
      ),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected quoted working directory inspection to fail");
    expect(inspection.message).toContain("invalid quoted working directory");
  });

  it("rejects unconsumed systemd environment syntax rather than checking a different context", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace("[Service]\n", "[Service]\nEnvironment=PATH=/custom/bin\n"),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected systemd environment inspection to fail");
    expect(inspection.message).toContain("environment entry");
  });

  it.each([
    'Environment="PI_WEB_CONFIG=/config" "PATH=/broken"',
    "EnvironmentFile=/tmp/pi-web.env",
  ])("rejects noncanonical systemd environment context: %s", (directive) => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace("[Service]\n", `[Service]\n${directive}\n`),
    }));

    expect(inspectInstalledDevelopmentServiceInput(plan.backend, definitions).ok).toBe(false);
  });

  it("rejects duplicate systemd ExecStart directives", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace(
        "Restart=no",
        'ExecStart=/usr/bin/env "/bin/zsh" -lc "exec true"\nRestart=no',
      ),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected duplicate ExecStart inspection to fail");
    expect(inspection.message).toContain("exactly one recognized ExecStart");
  });

  it("rejects malformed launchd environment dictionaries rather than dropping entries", () => {
    const plan = developmentPlan("launchd");
    const definitions = renderedDefinitions(plan).map((definition) => ({
      ...definition,
      contents: definition.contents.replace(
        "  </dict>\n  <key>RunAtLoad</key>",
        "    <key>BROKEN</key>\n    <integer>1</integer>\n  </dict>\n  <key>RunAtLoad</key>",
      ),
    }));

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected launchd environment inspection to fail");
    expect(inspection.message).toContain("environment dictionary");
  });

  it("rejects a modified development command rather than claiming to check the installed plan", () => {
    const plan = developmentPlan("systemd");
    const definitions = renderedDefinitions(plan);
    const firstDefinition = definitions[0];
    if (firstDefinition === undefined) throw new Error("Expected a rendered service definition");
    definitions[0] = {
      ...firstDefinition,
      contents: firstDefinition.contents.replace("exec npm run start:sessiond", "exec npm run something-else"),
    };

    const inspection = inspectInstalledDevelopmentServiceInput(plan.backend, definitions);
    expect(inspection.ok).toBe(false);
    if (inspection.ok) throw new Error("Expected development inspection to fail");
    expect(inspection.message).toContain("does not match the canonical development plan");
  });

  it("recovers production shell and environment while leaving executable strategy prospective", () => {
    const plan = developmentPlan("launchd");
    const firstService = plan.services[0];
    if (firstService === undefined) throw new Error("Expected a development service");
    const productionService = { ...firstService, workingDirectory: null };
    const productionPlan: NativeServicePlan = { ...plan, mode: "production", services: [productionService] };
    const productionLike = [{
      id: "sessiond" as const,
      contents: renderLaunchdPlist(productionPlan, productionService, "/tmp/logs"),
    }];
    expect(inspectInstalledProductionServiceContext(plan.backend, productionLike)).toEqual({
      ok: true,
      value: {
        shell,
        environment: { PI_WEB_CONFIG: "/home/user/config & dev.json" },
      },
    });
  });
});

describe("native-service doctor planning and reporting", () => {
  it("validates installed development requirements without production binary checks", async () => {
    const plan = developmentPlan("launchd");
    const inspected = inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan));
    if (!inspected.ok) throw new Error(inspected.message);

    const result = await runNativeServiceDoctor(
      { kind: "installed-development", input: inspected.value },
      { probe: probeWithStatus("satisfied"), fileExists: () => false },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report.ok).toBe(true);
    expect(report.lines).toContain("Installed development native-service plan:");
    expect(report.plan?.services.flatMap((service) => service.prerequisites)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ command: "pi-web-server" })]),
    );
  });

  it("does not recommend PATH changes for checkout metadata failures", async () => {
    const plan = developmentPlan("systemd");
    const inspected = inspectInstalledDevelopmentServiceInput(plan.backend, renderedDefinitions(plan));
    if (!inspected.ok) throw new Error(inspected.message);
    const result = await runNativeServiceDoctor(
      { kind: "installed-development", input: inspected.value },
      {
        probe: {
          run: (request) => Promise.resolve({
            kind: "completed",
            outcomes: request.prerequisites.map((prerequisite) => ({
              prerequisiteId: prerequisite.id,
              status: prerequisite.kind === "package-scripts" ? "unsatisfied" as const : "satisfied" as const,
              detail: prerequisite.kind === "package-scripts" ? "scripts missing" : null,
            })),
          }),
        },
        fileExists: () => true,
      },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report).toMatchObject({ ok: false, failureKind: "requirements", pathAdviceRecommended: false });
  });

  it("labels a production check as prospective and reports manager-context requirements", async () => {
    const target: NativeServiceDoctorTarget = {
      kind: "prospective-production",
      input: productionInput(),
      reason: "installed executable strategy is not recorded",
    };
    const result = await runNativeServiceDoctor(target, {
      probe: probeWithStatus("unsatisfied"),
      fileExists: () => true,
    });
    const report = formatNativeServiceDoctorResult(result);

    expect(report.ok).toBe(false);
    expect(report.failureKind).toBe("requirements");
    expect(report.lines[0]).toContain("Prospective production native-service plan");
    expect(report.lines.join("\n")).toContain("Native service requirement failed");
    expect(report.failedPrerequisites).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "node-version" }),
      expect.objectContaining({ kind: "readable-file" }),
    ]));
  });

  it("retains the installed production shell when resolution fails before a plan exists", async () => {
    const result = await runNativeServiceDoctor(
      { kind: "prospective-production", input: productionInput(), reason: "installed strategy is unknown" },
      { probe: probeWithStatus("unsatisfied"), fileExists: () => false },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report).toMatchObject({
      ok: false,
      failureKind: "requirements",
      plan: null,
      adviceShell: shell,
      pathAdviceRecommended: true,
    });
  });

  it("preserves configured overrides as unverified and does not probe arbitrary commands", async () => {
    let calls = 0;
    const result = await runNativeServiceDoctor(
      { kind: "prospective-production", input: productionInput(true), reason: "current configured overrides" },
      {
        probe: { run: () => { calls += 1; return Promise.resolve({ kind: "completed", outcomes: [] }); } },
        fileExists: () => false,
      },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(calls).toBe(1);
    expect(report.ok).toBe(true);
    expect(report.lines.join("\n")).toContain("does not execute arbitrary configured commands");
  });

  it.each(["manager", "timeout", "malformed-output", "cleanup"] as const)(
    "distinguishes %s infrastructure failures from PATH requirement drift",
    async (reason) => {
      const result = await runNativeServiceDoctor(
        { kind: "prospective-production", input: productionInput(), reason: "no installed services" },
        {
          probe: { run: () => Promise.resolve({ kind: "infrastructure-failure", reason, message: `${reason} failure` }) },
          fileExists: () => true,
        },
      );
      const report = formatNativeServiceDoctorResult(result);

      expect(report.ok).toBe(false);
      expect(report.failureKind).toBe("infrastructure");
      expect(report.lines.join("\n")).toContain(`infrastructure failure (${reason})`);
      expect(report.lines.join("\n")).toContain("not proof of a PATH mismatch");
    },
  );

  it("makes mixed or malformed installed definitions a failing inspection result", async () => {
    const result = await runNativeServiceDoctor(
      { kind: "inspection-failure", message: "production and development service IDs are both installed" },
      { probe: probeWithStatus("satisfied"), fileExists: () => true },
    );
    const report = formatNativeServiceDoctorResult(result);

    expect(report).toMatchObject({ ok: false, failureKind: "inspection" });
    expect(report.lines.join("\n")).toContain("could not be inspected");
  });
});
