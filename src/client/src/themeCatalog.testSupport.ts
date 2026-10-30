import definitions from "../../../pi-web-plugins/themes/package.json";
import { parseThemeCatalog } from "./themeCatalog";

/** Real shipped declarations projected into the HTTP fixture, without loading plugins. */
export function builtInThemeCatalog() {
  const plugin = definitions.piWeb.plugins[0];
  if (plugin === undefined) throw new Error("Missing built-in theme declarations");
  return parseThemeCatalog({
    themes: plugin.themes.map((theme) => ({
      ...theme, id: `${plugin.id}:${theme.id}`, pluginId: plugin.id,
      stylesheets: theme.stylesheets.map((sheet) => ({ id: `${plugin.id}:${theme.id}:${sheet.id}`, url: `pi-web-theme-assets/themes/revisions/test/${sheet.path}` })),
    })),
    themePairs: plugin.themePairs.map((pair) => ({ ...pair, id: `${plugin.id}:${pair.id}`, pluginId: plugin.id, light: `${plugin.id}:${pair.light}`, dark: `${plugin.id}:${pair.dark}` })),
  });
}
