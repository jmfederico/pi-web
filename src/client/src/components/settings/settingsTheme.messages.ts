import { message } from "../../localization/service";

export default {
  heading: message("Theme", "Theme settings heading and selector label"),
  description: message("Choose a theme for this browser, or save the gateway default.", "Theme settings scope"),
  local: message("Using a theme saved in this browser", "Theme preference source"),
  default: message("Using the default theme", "Theme preference source"),
  current: message<{ name: string }>("Current: {name}", "Current theme; name is plugin-owned"),
  gateway: message<{ name: string; auto: string }>("Default: {name}{auto, select, yes { · Follows system appearance} other {}}", "Gateway default theme and system appearance status"),
  catalogLoading: message("Loading themes…", "Theme catalog loading status"),
  catalogError: message<{ error: string }>("Couldn’t load themes. {error}", "Theme catalog load failure; error is the raw host diagnostic"),
  retryCatalog: message("Retry", "Retry loading the theme catalog"),
  unavailable: message<{ id: string }>("{id} (unavailable)", "Unavailable theme identifier; preserve id"),
  unavailableHelp: message("This theme is unavailable. Choose an available theme, or enable the plugin that provides it.", "Recovery for a missing theme plugin"),
  auto: message("Follow system appearance", "Automatic light/dark theme checkbox"),
  autoHelp: message("Switch between light and dark versions when this theme supports both.", "Automatic theme behavior"),
  useLocal: message("Use in this browser", "Apply staged theme only to this browser"),
  setDefault: message("Set gateway default", "Save staged theme as the gateway default"),
  useDefault: message("Use the default", "Remove this browser's theme override"),
  scope: message("Setting a default leaves saved browser choices unchanged. Use the default to remove this browser's override.", "Theme preference scope guidance"),
};
