import { describe, expect, it, vi } from "vitest";
import {
  PI_KEY,
  autoPullRequest,
  breakingChanges,
  changesetText,
  compareVersions,
  formatSpec,
  frozenManifest,
  parseSpec,
  piPullRequest,
  piSpec,
  planUnits,
  rewriteSpecs,
  satisfies,
  selectPassing,
  tail,
  updateHolds,
} from "../.github/scripts/dependency-updates.mjs";

const lockOf = (versions) => ({
  packages: Object.fromEntries(Object.entries(versions).map(([name, version]) => [`node_modules/${name}`, { version }])),
});

describe("version specs", () => {
  it("compares releases and prereleases", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(() => compareVersions("latest", "1.0.0")).toThrow(/Cannot compare/u);
  });

  it("parses and formats exact, caret, tilde and alias specs", () => {
    expect(parseSpec("^1.2.3")).toEqual({ alias: undefined, operator: "^", version: "1.2.3" });
    expect(parseSpec("npm:typebox@1.3.37")).toEqual({ alias: "typebox", operator: "", version: "1.3.37" });
    expect(parseSpec("npm:@scope/pkg@~2.0.0")).toEqual({ alias: "@scope/pkg", operator: "~", version: "2.0.0" });
    expect(parseSpec(">=1.0.0")).toBeUndefined();
    expect(formatSpec(parseSpec("npm:typebox@1.3.37"), "1.4.7")).toBe("npm:typebox@1.4.7");
    expect(formatSpec(parseSpec("^1.2.3"), "1.5.0", "")).toBe("1.5.0");
  });

  it.each([
    ["1.9.0", "^1.2.3", true], ["2.0.0", "^1.2.3", false], ["0.11.5", "^0.11.0", true], ["0.12.0", "^0.11.0", false],
    ["1.2.9", "~1.2.3", true], ["1.3.0", "~1.2.3", false], ["1.2.3", "1.2.3", true], ["1.2.4", "1.2.3", false],
    ["1.3.0-rc.1", "^1.2.3", false], ["1.4.7", "npm:typebox@^1.3.37", true],
  ])("decides whether %s satisfies %s", (version, spec, expected) => {
    expect(satisfies(version, spec)).toBe(expected);
  });

  it("moves the Pi floor to a new minor line but keeps a deliberate patch floor", () => {
    expect(piSpec("^1.6.0", "1.7.2")).toBe("^1.7.0");
    expect(piSpec("^1.6.3", "1.6.5")).toBe("^1.6.3");
    expect(piSpec("^1.6.0", "2.0.1")).toBe("^2.0.0");
  });
});

describe("planning", () => {
  const manifest = {
    dependencies: { fastify: "^5.12.7", "pi-web-typebox": "npm:typebox@1.3.37" },
    devDependencies: {
      [PI_KEY]: "^1.6.0", "@earendil-works/pi-ai": "^1.6.0", typescript: "^6.0.3", typebox: "1.3.27", eslint: "^10.0.0",
    },
  };
  const lock = lockOf({
    fastify: "5.12.7", "pi-web-typebox": "1.3.37", [PI_KEY]: "1.6.0", "@earendil-works/pi-ai": "1.6.0",
    typescript: "6.0.3", typebox: "1.3.27", eslint: "10.15.0",
  });
  const policy = {
    follow: { typebox: { dependencyOf: PI_KEY, reason: "Matches Pi." } },
    holds: { typescript: { version: "7.0.2", reason: "typescript-eslint does not support it yet." } },
  };
  const latest = {
    fastify: "5.12.8", "pi-web-typebox": "1.4.7", [PI_KEY]: "1.7.1", "@earendil-works/pi-ai": "1.7.1",
    typescript: "7.0.2", typebox: "1.4.7", eslint: "10.15.0",
  };

  it("plans one unit per dependency and one Pi unit that carries its followers", () => {
    const plan = planUnits({ manifest, lock, latest, policy, piDependencies: { typebox: "1.3.30" } });
    expect(plan.units.map((unit) => unit.id)).toEqual(["fastify", "pi-web-typebox"]);
    expect(plan.units[0].changes[0]).toMatchObject({ fromSpec: "^5.12.7", toSpec: "^5.12.7", toVersion: "5.12.8" });
    expect(plan.units[1].changes[0]).toMatchObject({ toSpec: "npm:typebox@1.4.7" });
    expect(plan.skipped).toEqual([{ name: "typescript", version: "7.0.2", reason: "typescript-eslint does not support it yet." }]);
    expect(plan.pi).toMatchObject({ major: false, fromVersion: "1.6.0", toVersion: "1.7.1" });
    expect(plan.pi.changes.map((change) => [change.name, change.toSpec])).toEqual([
      [PI_KEY, "^1.7.0"], ["@earendil-works/pi-ai", "^1.7.0"], ["typebox", "1.3.30"],
    ]);
  });

  it("retries a held version once a newer one is published and honours permanent holds", () => {
    const newer = planUnits({ manifest, lock, latest: { ...latest, typescript: "7.0.3" }, policy });
    expect(newer.units.map((unit) => unit.id)).toContain("typescript");
    const permanent = planUnits({ manifest, lock, latest, policy: { holds: { fastify: { version: "*", reason: "Pinned." } } } });
    expect(permanent.units.map((unit) => unit.id)).not.toContain("fastify");
  });

  it("marks a new Pi major and respects a Pi hold", () => {
    expect(planUnits({ manifest, lock, latest: { ...latest, [PI_KEY]: "2.0.0" }, policy }).pi.major).toBe(true);
    const held = planUnits({ manifest, lock, latest, policy: { holds: { [PI_KEY]: { version: "1.7.1", reason: "Waiting." } } } });
    expect(held.pi).toBeUndefined();
    expect(held.skipped).toContainEqual({ name: "Pi", version: "1.7.1", reason: "Waiting." });
  });

  it("pins kept dependencies to their locked versions while npm resolves", () => {
    const plan = planUnits({ manifest, lock, latest, policy });
    const frozen = frozenManifest(manifest, lock, [plan.units[0]]);
    expect(frozen.dependencies).toEqual({ fastify: "5.12.8", "pi-web-typebox": "npm:typebox@1.3.37" });
    expect(frozen.devDependencies.typescript).toBe("6.0.3");
  });

  it("rewrites only changed specs and keeps the manifest formatting", () => {
    const text = '{\n  "devDependencies": {\n    "a": "^1.0.0"\n  },\n  "peerDependenciesMeta": { "a": { "optional": true } }\n}\n';
    const unit = { changes: [{ name: "a", fromSpec: "^1.0.0", toSpec: "^2.0.0" }] };
    expect(rewriteSpecs(text, [unit])).toBe(text.replace("^1.0.0", "^2.0.0"));
    expect(() => rewriteSpecs(text, [{ changes: [{ name: "b", fromSpec: "1", toSpec: "2" }] }])).toThrow(/found 0/u);
  });
});

describe("selection", () => {
  const units = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const failing = (bad) => (set) => {
    const culprit = set.find((unit) => bad.includes(unit.id));
    return culprit === undefined ? { ok: true } : { ok: false, step: "npm test", excerpt: culprit.id };
  };

  it("accepts everything in one run when the checks pass", async () => {
    const attempt = vi.fn(failing([]));
    await expect(selectPassing(units, attempt)).resolves.toEqual({ accepted: units, rejected: [] });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("isolates the failing units and keeps the rest", async () => {
    const result = await selectPassing(units, failing(["b", "e"]));
    expect(result.accepted.map((unit) => unit.id)).toEqual(["a", "c", "d"]);
    expect(result.rejected.map(({ unit }) => unit.id)).toEqual(["b", "e"]);
  });

  it("retries a single check failure once, but not a resolution failure", async () => {
    const flaky = vi.fn().mockResolvedValueOnce({ ok: false, step: "npm test", excerpt: "" }).mockResolvedValue({ ok: true });
    await expect(selectPassing([units[0]], flaky)).resolves.toMatchObject({ accepted: [units[0]], rejected: [] });
    const conflict = vi.fn().mockResolvedValue({ ok: false, deterministic: true, step: "npm install", excerpt: "" });
    await expect(selectPassing([units[0]], conflict)).resolves.toMatchObject({ accepted: [] });
    expect(conflict).toHaveBeenCalledOnce();
  });
});

describe("holds", () => {
  const manifest = { devDependencies: { vite: "^8.0.0", eslint: "^10.0.0", knip: "^6.0.0" } };
  const change = (name, toVersion) => ({ name, field: "devDependencies", fromSpec: "^8.0.0", toSpec: "^8.0.0", toVersion });

  it("records failures with the reason, keeps human notes, and drops holds that no longer apply", () => {
    const policy = {
      holds: {
        vite: { version: "8.3.7", reason: "old", note: "Breaks the dev server proxy." },
        eslint: { version: "10.1.0", reason: "fixed upstream" },
        knip: { version: "6.48.0", reason: "accepted now" },
        removed: { version: "1.0.0", reason: "no longer a dependency" },
      },
    };
    const result = updateHolds(policy, {
      accepted: [{ id: "knip", kind: "package", changes: [change("knip", "6.48.0")] }],
      rejected: [{ unit: { id: "vite", kind: "package", changes: [change("vite", "8.3.8")] }, result: { step: "npm test", excerpt: "FAIL x" } }],
      manifest,
      lock: lockOf({ vite: "8.3.4", eslint: "10.15.0", knip: "6.48.0" }),
      today: "2026-11-26",
    });
    expect(result.holds).toEqual({
      vite: { note: "Breaks the dev server proxy.", version: "8.3.8", reason: "`npm test` failed with vite 8.3.8.", details: "FAIL x", recorded: "2026-11-26" },
    });
  });
});

describe("pull request text", () => {
  it("writes a changeset only for published dependency and Pi support changes", () => {
    const dev = { changes: [{ name: "vite", field: "devDependencies", fromSpec: "^8.0.0", toSpec: "^9.0.0" }] };
    expect(changesetText([dev])).toBeUndefined();
    const runtime = { changes: [{ name: "ws", field: "dependencies", fromSpec: "^8.0.0", toSpec: "^9.0.0" }] };
    const pi = { changes: [{ name: PI_KEY, field: "devDependencies", fromSpec: "^1.6.0", toSpec: "^1.7.0" }] };
    expect(changesetText([runtime, pi])).toBe(
      '---\n"@jmfederico/pi-web": patch\n---\n\nUpdate runtime dependencies: ws ^9.0.0. Support Pi 1.7.0 or later.\n',
    );
  });

  it("explains accepted and held updates and ends with the attribution", () => {
    const body = autoPullRequest({
      accepted: [{ id: "ws", kind: "package", changes: [{ name: "ws", fromSpec: "^8.0.0", toSpec: "^8.0.0", fromVersion: "8.22.0", toVersion: "8.23.0" }] }],
      rejected: [{ unit: { id: "refresh", kind: "refresh" }, result: { step: "npm test", excerpt: "FAIL" } }],
      skipped: [{ name: "typescript", version: "7.0.2", reason: "Not supported by typescript-eslint." }],
      refreshed: 0,
    }).body;
    expect(body).toMatch(/^## What and why\n/u);
    expect(body).toContain("- `ws` 8.22.0 → 8.23.0");
    expect(body).toContain("Indirect package updates: `npm test` failed");
    expect(body).toContain("- `typescript` 7.0.2: Not supported by typescript-eslint.");
    expect(body.trimEnd().endsWith("*Automatically generated by the user's AI workflow.*")).toBe(true);
  });

  it("asks for a decision on a Pi update and blocks automatic merging", () => {
    const unit = { major: false, fromVersion: "1.6.0", toVersion: "1.7.0", changes: [] };
    const pullRequest = piPullRequest({ unit, result: { ok: false, step: "npm test", excerpt: "FAIL" }, breaking: [] });
    expect(pullRequest).toMatchObject({ branch: "automation/pi-1.7.0", labels: ["do-not-merge"], assignees: ["jmfederico"] });
    expect(pullRequest.body).toContain("because `npm test` failed with it");
  });

  it("collects Pi breaking-change entries after the current version", () => {
    const changelog = [
      "## [Unreleased]", "### Breaking Changes", "- unreleased",
      "## [1.7.0] - 2026-12-01", "### Breaking Changes", "- render() is readonly", "### Fixed", "- not breaking",
      "## [1.6.1] - 2026-11-25", "### Breaking Changes", "- grep context",
      "## [1.6.0] - 2026-11-20", "### Breaking Changes", "- already adopted",
    ].join("\n");
    expect(breakingChanges(changelog, "1.6.0", "1.7.0")).toEqual([
      { version: "1.7.0", text: "render() is readonly" }, { version: "1.6.1", text: "grep context" },
    ]);
  });

  it("keeps the end of failing output without npm log noise", () => {
    expect(tail("npm error\nnpm error A complete log of this run can be found in: /x/_logs/y.log\nreal error\n")).toBe("real error");
  });
});
