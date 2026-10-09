import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareRelayDispatch } from "./relayDispatch.js";
import { RELAY_METADATA_NAMESPACE, relayIdentityFromMetadata, relaySessionName } from "./relayIdentity.js";

let cwd: string;
let packet: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-web-relay-dispatch-"));
  packet = join(cwd, ".pi-web", "relays", "workflow");
  await mkdir(packet, { recursive: true });
  await Promise.all(["charter.md", "status.md", "log.md"].map((file) => writeFile(join(packet, file), `# ${file}\nSaved packet content`)));
});
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("saved Relay dispatch", () => {
  it("generates handover pointers and explicit identity from the packet, without embedding an alternate baton", async () => {
    await writeFile(join(packet, "status.md"), "# Active\nThe actual baton is only saved here.");
    const prepared = await prepareRelayDispatch(cwd, { packet: ".pi-web/relays/workflow", leg: "3" });
    expect(prepared).toMatchObject({
      cwd, name: "Leg 3 – Relay workflow",
      identity: { version: 1, packetPath: ".pi-web/relays/workflow", relayName: "workflow", leg: "3" },
    });
    expect(prepared.metadata[RELAY_METADATA_NAMESPACE]).toEqual(prepared.identity);
    expect(relayIdentityFromMetadata(prepared.metadata)).toEqual(prepared.identity);
    expect(prepared.prompt).toContain(`Continue Relay "workflow", leg 3, in ${JSON.stringify(cwd)}.`);
    expect(prepared.prompt).toContain(JSON.stringify(join(packet, "charter.md")));
    expect(prepared.prompt).toContain(JSON.stringify(join(packet, "status.md")));
    expect(prepared.prompt).toContain("Load the `relay` and `relay-runner` skills.");
    expect(prepared.prompt).not.toContain("The actual baton is only saved here.");
  });

  it("resolves packets in a different target workspace and supports a custom packet location", async () => {
    const target = join(cwd, "worktree");
    await mkdir(target);
    await rm(packet, { recursive: true });
    const moved = join(target, "custom packet");
    await mkdir(moved);
    await Promise.all(["charter.md", "status.md", "log.md"].map((file) => writeFile(join(moved, file), "Saved text")));
    const prepared = await prepareRelayDispatch(cwd, { cwd: "worktree", packet: "custom packet", leg: "R1-a" });
    expect(prepared).toMatchObject({ cwd: target, identity: { packetPath: "custom packet", relayName: "custom packet", leg: "R1-a" } });
  });

  it.each(["charter.md", "status.md", "log.md"])("refuses a missing saved %s", async (document) => {
    await rm(join(packet, document));
    await expect(prepareRelayDispatch(cwd, { packet, leg: "1" })).rejects.toThrow("ENOENT");
  });

  it.each(["", " \n\t", "binary\0data", Buffer.from([0xff]), "x".repeat(256 * 1024 + 1)])("refuses empty, binary or oversized saved documents", async (text) => {
    await writeFile(join(packet, "status.md"), text);
    await expect(prepareRelayDispatch(cwd, { packet, leg: "1" })).rejects.toThrow(/Relay status.md/);
  });

  it("refuses a directory masquerading as a saved document", async () => {
    await rm(join(packet, "status.md"));
    await mkdir(join(packet, "status.md"));
    await expect(prepareRelayDispatch(cwd, { packet, leg: "1" })).rejects.toThrow("regular file");
  });

  it("refuses packets and document symlinks outside the target scope", async () => {
    await expect(prepareRelayDispatch(join(cwd, ".pi-web"), { packet, leg: "1" })).resolves.toMatchObject({ identity: { packetPath: "relays/workflow" } });
    await expect(prepareRelayDispatch(packet, { packet: "..", leg: "1" })).rejects.toThrow("inside the target workspace");
    await writeFile(join(cwd, "outside.md"), "outside");
    await rm(join(packet, "status.md"));
    await symlink(join(cwd, "outside.md"), join(packet, "status.md"));
    await expect(prepareRelayDispatch(cwd, { packet, leg: "1" })).rejects.toThrow("must stay inside the packet");
  });

  it.each([0, 1, -1, 1.5, true, false, null, undefined, "", "../1", "two words", "x".repeat(33)])("refuses an invalid or non-string leg identity (%s)", async (leg) => {
    // Deliberately exercise the untyped request boundary rather than cast input.
    const prepared: unknown = Reflect.apply(prepareRelayDispatch, undefined, [cwd, { packet, leg }]);
    await expect(prepared).rejects.toThrow("Relay leg");
  });
});

describe("Relay metadata interpretation", () => {
  it.each([undefined, {}, { [RELAY_METADATA_NAMESPACE]: { version: 2 } },
    { [RELAY_METADATA_NAMESPACE]: { version: 1, packetPath: "../outside", relayName: "outside", leg: "2" } },
    { [RELAY_METADATA_NAMESPACE]: { version: 1, packetPath: ".pi-web/relays/a", relayName: "b", leg: "2" } },
    { [RELAY_METADATA_NAMESPACE]: { version: 1, packetPath: ".pi-web/relays/a", relayName: "a", leg: "invalid leg" } },
  ])("does not infer membership from absent or invalid metadata", (metadata) => {
    expect(relayIdentityFromMetadata(metadata)).toBeUndefined();
  });

  it.each(["R1-a", "R".repeat(32)])("keeps leg %s first when shortening a long Relay name", (leg) => {
    const relayName = "a".repeat(100);
    const prefix = `Leg ${leg} – Relay `;
    const name = relaySessionName({ version: 1, packetPath: relayName, relayName, leg });
    expect(name).toHaveLength(60);
    expect(name).toBe(`${prefix}${"a".repeat(60 - prefix.length)}`);
  });
});
