import { describe, expect, it } from "vitest";
import { piWebDataDir } from "../../config.js";
import { sessiondSocketPath } from "../../sessiond/config.js";
import { PI_WEB_SESSION_ENV, sessionEnvironmentFacts, sessionEnvironmentPromptSections } from "./sessionEnvironmentFacts.js";

const ENV: NodeJS.ProcessEnv = {
  PI_WEB_DATA_DIR: "/data/pi-web",
  PI_WEB_SESSIOND_SOCKET: "/data/pi-web/sessiond.sock",
};

describe("sessionEnvironmentFacts", () => {
  it("marks the nesting and names the agent-visible marker", () => {
    const facts = sessionEnvironmentFacts({ env: ENV });

    expect(facts).toContain("runs inside a PI WEB session daemon");
    expect(facts).toContain(`\`${PI_WEB_SESSION_ENV}=1\``);
  });

  it("states which state the hosting instance owns", () => {
    const facts = sessionEnvironmentFacts({ env: ENV });

    // The facts embed the daemon's own resolutions verbatim; the configured
    // data dir resolves to a platform-native path.
    expect(facts).toContain(`owns the data directory \`${piWebDataDir(ENV)}\``);
    expect(facts).toContain(`listens on \`${sessiondSocketPath(ENV)}\``);
  });

  it("describes a TCP endpoint when a session daemon port is configured", () => {
    const facts = sessionEnvironmentFacts({
      env: { PI_WEB_DATA_DIR: "/data/pi-web", PI_WEB_SESSIOND_PORT: "7800" },
    });

    expect(facts).toContain("listens on `127.0.0.1:7800`");
  });

  it("resolves the default data dir and socket when nothing is configured", () => {
    const facts = sessionEnvironmentFacts({ env: {} });

    expect(facts).toContain(`owns the data directory \`${piWebDataDir({})}\``);
    expect(facts).toContain(`listens on \`${sessiondSocketPath({})}\``);
  });

  it("tells the agent the precautions a nested session must take", () => {
    const facts = sessionEnvironmentFacts({ env: ENV });

    expect(facts).toContain("a distinct `PI_WEB_DATA_DIR`, `PI_WEB_SESSIOND_SOCKET` (or `PI_WEB_SESSIOND_PORT` / `PI_WEB_SESSIOND_HOST`), and `PI_WEB_PORT`");
    expect(facts).toContain("fails loudly at startup because the live instance owns the state");
    expect(facts).toContain("Never restart or stop the session daemon hosting this session");
    expect(facts).toContain("restart the web/API process before the session daemon");
  });

  it("wraps the facts in one tagged block of plain statements", () => {
    const lines = sessionEnvironmentFacts({ env: ENV }).split("\n");

    expect(lines[0]).toBe("<pi_web_session_environment>");
    expect(lines.at(-1)).toBe("</pi_web_session_environment>");
    expect(lines.slice(2, -1).every((line) => line.startsWith("- "))).toBe(true);
  });
});

describe("sessionEnvironmentPromptSections", () => {
  it("returns one section when the facts are enabled", () => {
    expect(sessionEnvironmentPromptSections({ env: ENV, enabled: true })).toEqual([sessionEnvironmentFacts({ env: ENV })]);
  });

  it("returns nothing when the operator switched the facts off", () => {
    expect(sessionEnvironmentPromptSections({ env: ENV, enabled: false })).toEqual([]);
  });
});
