import { describe, expect, it } from "vitest";
import type { TemplateResult } from "lit";
import type { PiPackageInfo } from "../../api";
import { SettingsPackagesPanel } from "./SettingsPackagesPanel";
import type { SettingsNotice } from "./SettingsPanelFrame";
import type { PiPackageTargetContext } from "./piPackageSettings";

const remoteTarget: PiPackageTargetContext = { id: "lab-mac", name: "Lab Mac", kind: "remote" };

describe("settings-packages-panel layout", () => {
  it("shows a load-unavailable state instead of an empty package state when no response loaded", () => {
    const panel = new SettingsPackagesPanel();
    panel.targetMachine = remoteTarget;
    panel.error = "Failed to load Pi packages from Lab Mac (remote machine): Could not reach Lab Mac.";

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Failed to load Pi packages from Lab Mac (remote machine): Could not reach Lab Mac.",
      "Pi package list unavailable for Lab Mac (remote machine). Use Reload to try again.",
    ]);
    expect(rendered).not.toContain("No Pi packages configured");
    expect(rendered).not.toContain("Trusted code warning");
    expect(rendered).not.toContain("Pi package source");
    expect(rendered).not.toContain("Configured Pi packages");
  });

  it("shows trust guidance, install controls, and empty state only after a package response loaded", () => {
    const panel = new SettingsPackagesPanel();
    panel.packagesResponse = { packages: [] };

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Pi packages",
      "Managing Pi packages on ",
      "local (local gateway)",
      "Trusted code warning:",
      "Pi package source",
      "Configured Pi packages",
      "No Pi packages configured in Pi settings on local (local gateway) yet.",
    ]);
    expect(rendered).not.toContain("Pi package list unavailable");
  });

  it("orders package errors before the trusted-code warning while preserving loaded data", () => {
    const panel = new SettingsPackagesPanel();
    panel.targetMachine = remoteTarget;
    panel.packagesResponse = { packages: [packageInfo("npm:@acme/tools")] };
    panel.error = "Failed to refresh gateway PI WEB plugins after updating packages.";

    const rendered = flattenTemplateContent(panel.render());

    expectTextOrder(rendered, [
      "Failed to refresh gateway PI WEB plugins after updating packages.",
      "Trusted code warning:",
      "Pi package source",
      "Configured Pi packages",
      "npm:@acme/tools",
    ]);
  });
});

function flattenTemplateContent(template: TemplateResult): string {
  const chunks: string[] = [];
  visitTemplate(template);
  return chunks.join("");

  function visitTemplate(current: TemplateResult): void {
    const strings = templateStrings(current);
    const values = templateValues(current);
    for (let index = 0; index < values.length; index += 1) {
      const staticChunk = strings[index];
      if (staticChunk !== undefined) chunks.push(staticChunk);
      visitValue(values[index]);
    }
    const finalChunk = strings[values.length];
    if (finalChunk !== undefined) chunks.push(finalChunk);
  }

  function visitValue(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) visitValue(item);
      return;
    }
    if (isSettingsNotice(value)) {
      visitValue(value.title);
      visitValue(value.content);
      return;
    }
    if (isTemplateResult(value)) {
      visitTemplate(value);
      return;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      chunks.push(String(value));
    }
  }
}

function expectTextOrder(content: string, labels: readonly string[]): void {
  let previousIndex = -1;
  for (const label of labels) {
    const currentIndex = content.indexOf(label, previousIndex + 1);
    if (currentIndex === -1) throw new Error(`Expected rendered content to include ${label}`);
    expect(currentIndex).toBeGreaterThan(previousIndex);
    previousIndex = currentIndex;
  }
}

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

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isSettingsNotice(value: unknown): value is SettingsNotice {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string" && Reflect.has(value, "content");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

function packageInfo(source: string): PiPackageInfo {
  return { source, scope: "user", filtered: false, installedPath: `/pi/packages/${source}` };
}
