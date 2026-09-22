import { describe, expect, it } from "vitest";
import { en, interpolate, messageKeys, messagePlaceholders } from "./translate";
import { LocaleResourceStore } from "./resources";
// The Chinese catalog moved into an installable browser language pack; core
// keeps only the English defaults and the plugin resource path.
describe("translation plumbing", () => {
  it("keeps core keys namespace-qualified", () => {
    for (const key of messageKeys(en)) {
      expect(key.startsWith("core.")).toBe(true);
    }
  });

  it("interpolates parameters once and keeps missing parameters visible", () => {
    expect(interpolate(en["core.settings.generalDescription"], { targetLabel: "Lab Mac" }))
      .toBe("Gateway server fields edit this local gateway. File access and upload defaults edit Lab Mac.");
    expect(interpolate(en["core.settings.generalDescription"], { targetLabel: "{targetLabel}" })).toContain("{targetLabel}");
    expect(interpolate(en["core.settings.generalDescription"])).toContain("{targetLabel}");
    expect(messagePlaceholders(en["core.settings.generalDescription"])).toEqual(["targetLabel"]);
  });

  it("resolves plugin-provided dictionaries with per-key English fallback", () => {
    const resources = new LocaleResourceStore();
    resources.update([
      { locale: "zh-CN", label: "简体中文", namespace: "core", messages: { "common.reload": "重新加载" } },
      { locale: "zh-CN", label: "简体中文", namespace: "plugin.git", messages: { "openFile": "打开文件" } },
    ]);

    expect(resources.message("zh-CN", "core.common.reload")).toBe("重新加载");
    expect(resources.message("zh-CN", "plugin.git.openFile")).toBe("打开文件");
    expect(resources.message("zh-CN", "core.language.label")).toBe("Language");
    expect(resources.message("en", "core.common.reload")).toBe("Reload");
  });
});
