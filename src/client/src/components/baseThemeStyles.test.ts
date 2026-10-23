// @vitest-environment happy-dom
import { generate, parse } from "css-tree";
import { expect, it } from "vitest";
import { ImagePresentation } from "./ImagePresentation";
import { SettingsDialog } from "./SettingsDialog";
import { SettingsGeneralPanel } from "./settings/SettingsGeneralPanel";
import { NavigationDialog } from "./appShell/NavigationDialog";

// These consumers combine generic local defaults with more-specific primitives.
// Unlayered defaults would silently reverse specificity for hover states, heading
// typography and title spacing. Browser checks establish the rendered appearance.
it.each([
  ["image controls", ImagePresentation.styles],
  ["settings dialog", SettingsDialog.styles],
  ["general settings", SettingsGeneralPanel.styles],
  ["navigation dialog", NavigationDialog.styles],
] as const)("keeps %s defaults in the same cascade layer as its primitives", (_name, styles) => {
  for (const style of styles) {
    const ast = parse(style.cssText);
    if (ast.type !== "StyleSheet") throw new Error("Expected a stylesheet");
    ast.children.forEach((node) => {
      if (node.type === "Comment") return;
      expect(node.type).toBe("Atrule");
      if (node.type !== "Atrule") throw new Error("Unlayered consumer default");
      expect(node.name).toBe("layer");
      expect(node.prelude && generate(node.prelude)).toBe("pi-web-base");
    });
  }
});
