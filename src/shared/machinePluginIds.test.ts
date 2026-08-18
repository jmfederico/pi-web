import { describe, expect, it } from "vitest";
import { machineScopedPluginId, parseMachineScopedPluginId } from "./machinePluginIds";

describe("machine-scoped plugin ids", () => {
  it("encodes machine ids into valid plugin ids and decodes them", () => {
    const scoped = machineScopedPluginId("550e8400-e29b-41d4-a716-446655440000", "project-tools");

    expect(scoped).toMatch(/^machine\.[0-9a-f]+\.project-tools$/u);
    expect(parseMachineScopedPluginId(scoped)).toEqual({ machineId: "550e8400-e29b-41d4-a716-446655440000", pluginId: "project-tools" });
  });

  it("leaves normal plugin ids unparsed", () => {
    expect(parseMachineScopedPluginId("project-tools")).toBeUndefined();
  });

  it.each(["core", "themes", "machine.remote.tools"])("does not scope reserved external id %s", (pluginId) => {
    expect(() => machineScopedPluginId("remote-1", pluginId)).toThrow(`Reserved PI WEB plugin id: ${pluginId}`);
  });

  it("does not decode nested machine namespaces as source plugin ids", () => {
    expect(parseMachineScopedPluginId("machine.72656d6f74652d31.machine.remote.tools")).toBeUndefined();
  });
});
