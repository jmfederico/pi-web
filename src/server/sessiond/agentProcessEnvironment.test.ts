import { describe, expect, it } from "vitest";
import { isAgentVisibleEnvKey, scrubNonAgentVisibleEnvKeys } from "./agentProcessEnvironment.js";

describe("agent process environment visibility", () => {
  it("keeps the ordinary environment agent processes rely on", () => {
    const ordinary = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "HTTP_PROXY", "NPM_CONFIG_CACHE"];
    for (const key of ordinary) expect(isAgentVisibleEnvKey(key)).toBe(true);
  });

  it("keeps the daemon's PI_WEB_* wiring visible, so nested instances fail loudly instead of silently", () => {
    // State ownership, not env hiding, is the protection against a second
    // instance: a nested daemon inheriting these keys resolves the live
    // instance's state and fails with an actionable conflict error.
    const daemonKeys = [
      "PI_WEB_DATA_DIR",
      "PI_WEB_CONFIG",
      "PI_WEB_SESSIOND_SOCKET",
      "PI_WEB_SESSIOND_PORT",
      "PI_WEB_SESSIOND_HOST",
      "PI_WEB_SESSIOND_URL",
      "PI_WEB_HOST",
      "PI_WEB_PORT",
      "PI_WEB_ALLOWED_HOSTS",
      "PI_WEB_MAX_UPLOAD_BYTES",
      // Deprecated aliases stay visible; the exported canonical
      // PI_CODING_AGENT_* values make both names resolve identically.
      "PI_WEB_AGENT_DIR",
      "PI_WEB_AGENT_SESSION_DIR",
      "PI_WEB_SPAWN_SESSIONS",
      "PI_WEB_SUBSESSIONS",
      "PI_WEB_ASK_USER",
      "PI_WEB_OFFLINE",
      // The nesting marker every session process carries.
      "PI_WEB_SESSION",
      // Nothing prefix-filters anymore, so future daemon configuration is
      // inherited the same way.
      "PI_WEB_WHATEVER_COMES_NEXT",
    ];
    for (const key of daemonKeys) expect(isAgentVisibleEnvKey(key)).toBe(true);
  });

  it("keeps deployment descriptors that agent-facing tools read", () => {
    const agentFacing = [
      "PI_WEB_DOCKER_MODE",
      "PI_WEB_DOCKER_RUNTIME",
      "PI_WEB_DOCKER_INSTALL_DIR",
      "PI_WEB_DOCKER_HELPER_IMAGE",
      "HOSTEXEC_MODE",
      "HOSTEXEC_IMAGE",
      // Agents running the `pi` CLI need the profile's auth and models, and a
      // deployment-set session dir must apply to agent-run `pi` CLIs the same
      // way it applies to the daemon.
      "PI_CODING_AGENT_DIR",
      "PI_CODING_AGENT_SESSION_DIR",
      "PI_OFFLINE",
    ];
    for (const key of agentFacing) expect(isAgentVisibleEnvKey(key)).toBe(true);
  });

  it("hides only the app runtime keys that distort development tooling", () => {
    // NODE_ENV=production makes npm omit devDependencies and flips Node
    // package-export conditions; PORT is the web/API's listener config.
    expect(isAgentVisibleEnvKey("NODE_ENV")).toBe(false);
    expect(isAgentVisibleEnvKey("PORT")).toBe(false);
  });

  it("removes only NODE_ENV and PORT from the environment and reports them sorted", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/data/home",
      NODE_ENV: "production",
      PORT: "8504",
      PI_WEB_DATA_DIR: "/data/pi-web",
      PI_WEB_SESSIOND_SOCKET: "/data/pi-web/sessiond.sock",
      PI_WEB_SESSION: "1",
      PI_WEB_DOCKER_MODE: "runtime",
      HOSTEXEC_MODE: "nsenter",
    };

    const scrubbed = scrubNonAgentVisibleEnvKeys(env);

    expect(scrubbed).toEqual(["NODE_ENV", "PORT"]);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/data/home",
      PI_WEB_DATA_DIR: "/data/pi-web",
      PI_WEB_SESSIOND_SOCKET: "/data/pi-web/sessiond.sock",
      PI_WEB_SESSION: "1",
      PI_WEB_DOCKER_MODE: "runtime",
      HOSTEXEC_MODE: "nsenter",
    });
  });
});
