import { describe, expect, it } from "vitest";
import { en, messageKeys, messagePlaceholders, translate, zhCN } from "./translate";

describe("translation catalogs", () => {
  it("keeps Chinese keys and interpolation placeholders aligned with English", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
    for (const key of messageKeys()) {
      expect([...messagePlaceholders(zhCN[key])].sort()).toEqual([...messagePlaceholders(en[key])].sort());
    }
  });

  it("interpolates target names once and keeps missing parameters visible", () => {
    expect(translate("en", "settings.generalDescription", { targetLabel: "Lab Mac" }))
      .toBe("Gateway server fields edit this local gateway. File access and upload defaults edit Lab Mac.");
    expect(translate("zh-CN", "settings.generalDescription", { targetLabel: "{targetLabel}" })).toContain("{targetLabel}");
    expect(translate("en", "settings.generalDescription")).toContain("{targetLabel}");
  });
});
