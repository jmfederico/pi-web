import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isViteHostHeaderAllowed,
  loadSafeTunnelManagedAllowedHosts,
  mergeViteAllowedHosts,
  safeTunnelManagedAllowedHosts,
} from "./safeTunnelManagedHosts.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )));
});

describe("Safe Tunnel managed allowed hosts", () => {
  it("derives only the exact normalized hostname from a saved public URL", () => {
    expect(safeTunnelManagedAllowedHosts(
      "https://6DB2D7B1126A-79933D6E.ns-ee5ab119a58b763c.staging.tunnels.pi-web.dev/",
    )).toEqual([{
      source: "safe-tunnel",
      hostname: "6db2d7b1126a-79933d6e.ns-ee5ab119a58b763c.staging.tunnels.pi-web.dev",
    }]);
    expect(safeTunnelManagedAllowedHosts("https://tunnel.example.test/path"))
      .toEqual([]);
    expect(safeTunnelManagedAllowedHosts("http://tunnel.example.test"))
      .toEqual([]);
    expect(safeTunnelManagedAllowedHosts("https://.com"))
      .toEqual([]);
    expect(safeTunnelManagedAllowedHosts("https://%2eexample.test"))
      .toEqual([]);
    expect(safeTunnelManagedAllowedHosts(undefined)).toEqual([]);
  });

  it("merges the managed hostname without broadening or replacing configured policy", () => {
    const managed = safeTunnelManagedAllowedHosts("https://machine.namespace.tunnels.example.test");

    expect(mergeViteAllowedHosts(["gateway.example.test", "machine.namespace.tunnels.example.test"], managed))
      .toEqual(["gateway.example.test", "machine.namespace.tunnels.example.test"]);
    expect(mergeViteAllowedHosts(undefined, managed))
      .toEqual(["machine.namespace.tunnels.example.test"]);
    expect(mergeViteAllowedHosts(true, managed)).toBe(true);
  });

  it("fails closed when the private state file is missing or invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-web-managed-hosts-"));
    tempDirectories.push(directory);
    const statePath = join(directory, "safe-tunnel", "config.json");

    await expect(loadSafeTunnelManagedAllowedHosts(statePath)).resolves.toEqual([]);
    await mkdir(join(directory, "safe-tunnel"), { recursive: true });
    await writeFile(statePath, "not json");
    await expect(loadSafeTunnelManagedAllowedHosts(statePath)).resolves.toEqual([]);
  });
});

describe("Vite proxy host matching", () => {
  const allowedHosts = [
    "gateway.example.test",
    "machine.namespace.tunnels.example.test",
    ".dev.example.test",
  ] as const;

  it.each([
    "gateway.example.test",
    "gateway.example.test:8505",
    "machine.namespace.tunnels.example.test",
    "localhost:8505",
    "app.localhost:8505",
    "127.0.0.1:8505",
    "[::1]:8505",
    "dev.example.test",
    "nested.dev.example.test",
  ])("accepts Vite-trusted Host %s", (host) => {
    expect(isViteHostHeaderAllowed(host, allowedHosts)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "attacker.example.test",
    "machine.namespace.tunnels.example.test.attacker.test",
    "[not-an-ipv6-address]:8505",
  ])("rejects untrusted or malformed Host %s", (host) => {
    expect(isViteHostHeaderAllowed(host, allowedHosts)).toBe(false);
  });

  it("preserves the explicit allow-every-host override", () => {
    expect(isViteHostHeaderAllowed("attacker.example.test", true)).toBe(true);
    expect(isViteHostHeaderAllowed(undefined, true)).toBe(true);
  });
});
