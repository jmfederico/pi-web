import { describe, expect, it } from "vitest";
import type { TemplateResult } from "lit";
import { SettingsSessiondPanel } from "./SettingsSessiondPanel";

describe("settings-sessiond-panel copy", () => {
  it("names the selected machine in the scope and restart copy", () => {
    const panel = new SettingsSessiondPanel();
    panel.targetLabel = "Lab Mac (remote machine)";

    const template = panel.render();
    const strings = templateStrings(template);
    const values = templateValues(template);

    expect(values.filter((value) => value === "Lab Mac (remote machine)")).toHaveLength(2);
    expect(strings.join("")).toContain("These settings affect the long-lived session runtime on ");
    expect(strings.join("")).toContain("Restart required on ");
    expect(strings.join("")).toContain("run <code>pi-web restart</code> on that machine");
  });
});

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}
