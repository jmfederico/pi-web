import { describe, expect, it } from "vitest";
import { PluginRegistry } from "./registry";
import type { LocaleContribution, PiWebPlugin } from "./types";

function localePlugin(name: string, locales: readonly LocaleContribution[]): PiWebPlugin {
  return {
    apiVersion: 4,
    name,
    activate: () => ({ contributions: { locales } }),
  };
}

const zhCore: LocaleContribution = {
  id: "core",
  locale: "zh-CN",
  label: "简体中文",
  aliases: ["zh-Hans", "zh-SG"],
  namespace: "core",
  messages: { "settings.generalConfiguration": "常规配置", "common.reload": "重新加载" },
};

const zhGit: LocaleContribution = {
  id: "git",
  locale: "zh-CN",
  label: "简体中文",
  namespace: "plugin.git",
  messages: { "openFile": "打开文件" },
};

describe("PluginRegistry locale contributions", () => {
  it("publishes validated gateway locale contributions and qualifies their ids", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "locale-zh", plugin: localePlugin("Chinese pack", [zhCore, zhGit]) });

    const locales = registry.getLocales();
    expect(locales.map(({ id, locale, namespace }) => ({ id, locale, namespace }))).toEqual([
      { id: "locale-zh:core", locale: "zh-CN", namespace: "core" },
      { id: "locale-zh:git", locale: "zh-CN", namespace: "plugin.git" },
    ]);
    expect(locales[0]).toMatchObject({ label: "简体中文", aliases: ["zh-Hans", "zh-SG"] });
    expect(locales[0]?.messages).toEqual({ "settings.generalConfiguration": "常规配置", "common.reload": "重新加载" });
  });

  it("accepts the same locale through different namespaces from separate plugins", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "pack-a", plugin: localePlugin("Pack A", [zhCore]) });
    await registry.register({ id: "pack-b", plugin: localePlugin("Pack B", [zhGit]) });

    expect(registry.getLocales()).toHaveLength(2);
  });

  it("fails validation deterministically for duplicate (locale, namespace, key) provision", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "pack-a", plugin: localePlugin("Pack A", [zhCore]) });
    const conflicting: LocaleContribution = { ...zhCore, id: "core-again", messages: { "common.reload": "重新加载（冲突）" } };

    await expect(registry.register({ id: "pack-b", plugin: localePlugin("Pack B", [conflicting]) }))
      .rejects.toThrow("Duplicate locale message for zh-cn core.common.reload in browser plugin pack-b");
    expect(registry.getLocales()).toHaveLength(1);
  });

  it("rejects duplicate keys within one plugin and duplicate contribution ids", async () => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "pack", plugin: localePlugin("Pack", [
      { ...zhCore, id: "dup", messages: {} },
      { ...zhGit, id: "dup", messages: {} },
    ]) })).rejects.toThrow("Duplicate contribution id: pack:dup");

    const registry2 = new PluginRegistry();
    await expect(registry2.register({ id: "pack", plugin: localePlugin("Pack", [
      { ...zhCore, id: "one", messages: { "common.reload": "重新加载" } },
      { ...zhCore, id: "two", messages: { "common.reload": "重复" } },
    ]) })).rejects.toThrow("Duplicate locale message for zh-cn core.common.reload in browser plugin pack");

    expect(registry.getLocales()).toEqual([]);
    expect(registry2.getLocales()).toEqual([]);
  });

  it.each([
    ["locale tag", { locale: "zh_CN!" }],
    ["empty label", { label: "  " }],
    ["namespace", { namespace: "Plugin.Git" }],
    ["message value", { messages: { "common.reload": "" } }],
    ["message key", { messages: { "bad key!": "重新加载" } }],
  ])("rejects invalid %s values", async (_label, patch) => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "pack", plugin: localePlugin("Pack", [{ ...zhCore, ...patch }]) }))
      .rejects.toThrow();
    expect(registry.getLocales()).toEqual([]);
  });

  it("rolls back locale claims when start fails so a later plugin can provide them", async () => {
    const registry = new PluginRegistry();
    const failing: PiWebPlugin = {
      apiVersion: 4,
      name: "Failing pack",
      activate: () => ({
        contributions: { locales: [zhCore] },
        start: () => { throw new Error("start failed"); },
      }),
    };
    const failingRegistration = await registry.registerBatch([{ id: "pack-a", plugin: failing }], {});
    expect(failingRegistration.failures[0]?.phase).toBe("start");
    expect(registry.getLocales()).toEqual([]);

    await registry.register({ id: "pack-b", plugin: localePlugin("Recovery pack", [zhCore]) });
    expect(registry.getLocales()).toHaveLength(1);
  });

  it("releases claims of a failed same-batch plugin so later plugins may claim them", async () => {
    const registry = new PluginRegistry();
    const failing: PiWebPlugin = {
      apiVersion: 4,
      name: "Failing pack",
      activate: () => ({
        contributions: { locales: [zhCore] },
        start: () => { throw new Error("start failed"); },
      }),
    };
    const result = await registry.registerBatch([
      { id: "pack-a", plugin: failing },
      { id: "pack-b", plugin: localePlugin("Recovery pack", [zhCore]) },
    ], {});

    expect(result.failures.map(({ declaration }) => declaration.id)).toEqual(["pack-a"]);
    expect(registry.getLocales().map(({ pluginId }) => pluginId)).toEqual(["pack-b"]);
  });

  it("rejects a same-batch cross-plugin duplicate at the later plugin's publish", async () => {
    const registry = new PluginRegistry();
    const result = await registry.registerBatch([
      { id: "pack-a", plugin: localePlugin("Pack A", [zhCore]) },
      { id: "pack-b", plugin: localePlugin("Pack B", [zhCore]) },
    ], {});

    expect(result.failures.map(({ declaration, phase }) => `${declaration.id}:${phase}`)).toEqual(["pack-b:start"]);
    expect(registry.getLocales().map(({ pluginId }) => pluginId)).toEqual(["pack-a"]);
  });

  it("ignores remote machine locale contributions", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "remote-pack", machineId: "remote-1", sourcePluginId: "pack", plugin: localePlugin("Remote pack", [zhCore]) });

    expect(registry.getLocales()).toEqual([]);
  });

  it("clears locale contributions on host disposal", async () => {
    const registry = new PluginRegistry();
    await registry.register({ id: "pack-a", plugin: localePlugin("Pack A", [zhCore]) });
    expect(registry.getLocales()).toHaveLength(1);

    await registry.dispose();

    expect(registry.getLocales()).toEqual([]);
    // The released keys are claimable again after disposal.
    const revived = new PluginRegistry();
    await revived.register({ id: "pack-b", plugin: localePlugin("Pack B", [zhCore]) });
    expect(revived.getLocales()).toHaveLength(1);
  });

  it("gates locale visibility through the host contribution gate", async () => {
    let enabled = true;
    const registry = new PluginRegistry({ isContributionEnabled: (pluginId) => pluginId !== "pack-a" || enabled });
    await registry.register({ id: "pack-a", plugin: localePlugin("Pack A", [zhCore]) });
    await registry.register({ id: "pack-b", plugin: localePlugin("Pack B", [{ ...zhGit }]) });

    expect(registry.getLocales().map(({ pluginId }) => pluginId)).toEqual(["pack-a", "pack-b"]);
    enabled = false;
    expect(registry.getLocales().map(({ pluginId }) => pluginId)).toEqual(["pack-b"]);
  });

  it("rejects underscore-separated tags and drops redundant aliases", async () => {
    const registry = new PluginRegistry();
    await expect(registry.register({ id: "pack", plugin: localePlugin("Pack", [{
      id: "core",
      locale: "zh_CN",
      label: "简体中文",
      namespace: "core",
      messages: { "common.reload": "重新加载" },
    }]) })).rejects.toThrow("Invalid locale language tag for browser plugin pack: zh_CN");

    const normalized = new PluginRegistry();
    await normalized.register({ id: "pack", plugin: localePlugin("Pack", [{
      id: "core",
      locale: "zh-CN",
      label: "简体中文",
      aliases: ["zh-Hans", "zh-hans", "zh-CN"],
      namespace: "core",
      messages: { "common.reload": "重新加载" },
    }]) });

    expect(normalized.getLocales()[0]).toMatchObject({ locale: "zh-CN", aliases: ["zh-Hans"] });
  });
});
