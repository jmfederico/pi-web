import { describe, expect, it } from "vitest";
import { createSafeTunnelMutationHostBoundary } from "./safeTunnelMutationHosts.js";

const hostname = "machine.namespace.tunnels.example.test";
const registeredOrigin = () => Promise.resolve(`https://${hostname}`);

describe("Safe Tunnel exact registered-host trust", () => {
  const boundary = createSafeTunnelMutationHostBoundary({
    listenerHost: "127.0.0.1",
    allowedHosts: ["gateway.example.test", ".tunnels.example.test"],
  });

  it("accepts the exact saved hostname and independently configured hosts", async () => {
    for (const host of [hostname, "gateway.example.test", "127.0.0.1"]) {
      await expect(boundary.allowsRead({ host }, registeredOrigin)).resolves.toBe(true);
      await expect(boundary.allowsMutation({
        host: `${host}:8504`, origin: `https://${host}:4433`,
      }, registeredOrigin)).resolves.toBe(true);
    }
  });

  it.each([
    "sibling.namespace.tunnels.example.test",
    "namespace.tunnels.example.test",
    `child.${hostname}`,
    `${hostname}.attacker.test`,
  ])("does not infer trust for %s", async (untrusted) => {
    await expect(boundary.allowsRead({ host: untrusted }, registeredOrigin)).resolves.toBe(false);
    for (const [host, originHost] of [
      [untrusted, untrusted], [hostname, untrusted], [untrusted, hostname],
      ["127.0.0.1", untrusted],
    ] as const) {
      await expect(boundary.allowsMutation({
        host, origin: `https://${originHost}`,
      }, registeredOrigin)).resolves.toBe(false);
    }
  });

  it("allows an independently configured sibling without trusting its neighbors", async () => {
    const sibling = "sibling.namespace.tunnels.example.test";
    const configured = createSafeTunnelMutationHostBoundary({ allowedHosts: [sibling] });
    await expect(configured.allowsMutation({
      host: sibling, origin: `https://${sibling}`,
    }, registeredOrigin)).resolves.toBe(true);
  });

  it("retains plaintext development ingress only for the exact registered loopback name", async () => {
    const host = "machine.namespace.tunnels.localhost";
    const registration = () => Promise.resolve(`https://${host}`);
    await expect(boundary.allowsMutation({
      host: `${host}:8788`, origin: `http://${host}:8788`,
    }, registration)).resolves.toBe(true);
    await expect(boundary.allowsMutation({
      host, origin: "http://sibling.namespace.tunnels.localhost:8788",
    }, registration)).resolves.toBe(false);
    await expect(boundary.allowsMutation({
      host: hostname, origin: `http://${hostname}`,
    }, registeredOrigin)).resolves.toBe(false);
  });

  it.each([undefined, "null", "", "not-an-origin", `https://${hostname}/path`])(
    "rejects missing or invalid mutation provenance %s", async (origin) => {
      await expect(boundary.allowsMutation({ host: hostname, origin }, registeredOrigin))
        .resolves.toBe(false);
    },
  );

  it.each([undefined, "invalid", "http://machine.namespace.tunnels.example.test"])(
    "does not establish trust from invalid registration %s", async (registration) => {
      const readRegistration = () => Promise.resolve(registration);
      await expect(boundary.allowsRead({ host: hostname }, readRegistration)).resolves.toBe(false);
      await expect(boundary.allowsMutation({
        host: hostname, origin: `https://${hostname}`,
      }, readRegistration)).resolves.toBe(false);
    },
  );
});
