import { describe, expect, it } from "vitest";
import { machineScopedBundledPluginId, machineScopedManifestPluginId, machineScopedPluginId, parseMachineScopedPluginId } from "./machinePluginIds";

describe("machine-scoped plugin ids", () => {
  it("encodes machine ids into valid plugin ids and decodes them", () => {
    const scoped = machineScopedPluginId("550e8400-e29b-41d4-a716-446655440000", "project-tools");

    expect(scoped).toMatch(/^machine\.[0-9a-f]+\.project-tools$/u);
    expect(parseMachineScopedPluginId(scoped)).toEqual({ machineId: "550e8400-e29b-41d4-a716-446655440000", pluginId: "project-tools" });
  });

  it("leaves normal plugin ids unparsed", () => {
    expect(parseMachineScopedPluginId("project-tools")).toBeUndefined();
  });

  it.each(["core", "themes", "machine.remote.tools", "pi-web", "pi-web.tools"])("does not scope reserved external id %s", (pluginId) => {
    expect(() => machineScopedPluginId("remote-1", pluginId)).toThrow(`Reserved PI WEB plugin id: ${pluginId}`);
  });

  it("scopes a host-validated bundled id for federation", () => {
    const scoped = machineScopedBundledPluginId("remote-1", "pi-web.terminal");

    expect(parseMachineScopedPluginId(scoped)).toEqual({ machineId: "remote-1", pluginId: "pi-web.terminal" });
    expect(machineScopedManifestPluginId("remote-1", "pi-web.terminal")).toBe(scoped);
    expect(machineScopedManifestPluginId("remote-1", "terminal")).toBe(machineScopedPluginId("remote-1", "terminal"));
    expect(() => machineScopedBundledPluginId("remote-1", "terminal")).toThrow("PI WEB bundled plugin id is required");
  });

  it("does not decode nested machine namespaces as source plugin ids", () => {
    expect(parseMachineScopedPluginId("machine.72656d6f74652d31.machine.remote.tools")).toBeUndefined();
  });
});
