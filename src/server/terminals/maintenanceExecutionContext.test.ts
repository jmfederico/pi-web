import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { piWebDataDir } from "../../config.js";
import { resolveMaintenanceExecutionContext } from "./maintenanceExecutionContext.js";
import { MAINTENANCE_TERMINAL_CAPABILITY } from "./maintenanceTerminalCapability.js";
import { scrubNonAgentVisibleEnvKeys } from "../sessiond/agentProcessEnvironment.js";

const launchCwd = resolve("/daemon/launch");

describe("maintenance execution configuration", () => {
  it("resolves inherited configuration paths against the captured launch cwd without mutating inputs", () => {
    const paths = {
      PI_WEB_DATA_DIR: "state",
      PI_WEB_CONFIG: "config/settings.json",
      PI_WEB_SESSIOND_SOCKET: "sockets/sessiond.sock",
      PI_WEB_PI_PACKAGE_DIR: "sdk",
      PI_WEB_SESSION_ARCHIVE_DIR: "archives",
      PI_CODING_AGENT_DIR: "agent",
      PI_CODING_AGENT_SESSION_DIR: "sessions",
    };
    const env = { ...paths, PATH: "bin:other-bin", CUSTOM: "unchanged" };
    const result = resolveMaintenanceExecutionContext(env, launchCwd);
    expect(result.cwd).toBe(join(launchCwd, "state", "maintenance"));
    for (const [key, value] of Object.entries(paths)) expect(result.env[key]).toBe(resolve(launchCwd, value));
    expect(result.env["PATH"]).toBe(env.PATH);
    expect(result.env["CUSTOM"]).toBe("unchanged");
    expect(env.PI_WEB_DATA_DIR).toBe("state");
    env.CUSTOM = "changed";
    expect(result.env["CUSTOM"]).toBe("unchanged");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.env)).toBe(true);
  });

  it("preserves the prepared profile and nesting marker without restoring scrubbed daemon variables", () => {
    const prepared = {
      PI_CODING_AGENT_DIR: resolve(launchCwd, "active-profile"),
      PI_WEB_SESSION: "1",
      NODE_ENV: "production",
      PORT: "9000",
    };
    scrubNonAgentVisibleEnvKeys(prepared);
    const result = resolveMaintenanceExecutionContext(prepared, launchCwd);
    expect(result.env["PI_CODING_AGENT_DIR"]).toBe(prepared.PI_CODING_AGENT_DIR);
    expect(result.env["PI_WEB_SESSION"]).toBe("1");
    expect(result.env).not.toHaveProperty("NODE_ENV");
    expect(result.env).not.toHaveProperty("PORT");
  });

  it("retains absolute paths and empty overrides, leaves absent overrides absent", () => {
    const env = { PI_WEB_DATA_DIR: "", PI_WEB_CONFIG: "", PI_WEB_SESSIOND_SOCKET: "", PI_CODING_AGENT_DIR: resolve("/profiles/agent") };
    const result = resolveMaintenanceExecutionContext(env, launchCwd);
    expect(result.env).toEqual(env);
    expect(result.cwd).toBe(join(piWebDataDir(env, launchCwd), "maintenance"));
    expect(result.env).not.toHaveProperty("PI_WEB_SESSION_ARCHIVE_DIR");
  });

  it("preserves whitespace-only directory meaning rather than silently selecting a default", () => {
    const result = resolveMaintenanceExecutionContext({ PI_WEB_DATA_DIR: " " }, launchCwd);
    expect(result.cwd).toBe(join(launchCwd, " ", "maintenance"));
    expect(result.env["PI_WEB_DATA_DIR"]).toBe(resolve(launchCwd, " "));
  });
});

describe("private maintenance capability", () => {
  it("snapshots the execution context", () => {
    const env = { CUSTOM: "original" };
    const result = MAINTENANCE_TERMINAL_CAPABILITY.parse({ cwd: launchCwd, env });
    env.CUSTOM = "changed";
    expect(result.env["CUSTOM"]).toBe("original");
    expect(Object.isFrozen(result.env)).toBe(true);
  });

  it.each([null, {}, { cwd: "relative", env: {} }, { cwd: launchCwd }, { cwd: launchCwd, env: [] }, { cwd: launchCwd, env: { BAD: 1 } }])("rejects malformed host execution context: %j", (value) => {
    expect(() => MAINTENANCE_TERMINAL_CAPABILITY.parse(value)).toThrow();
  });
});
