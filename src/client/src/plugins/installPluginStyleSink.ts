import { installPluginStyleSink } from "./pluginStyles";

// Side-effect entrypoint: install the plugin style sink as this module is
// evaluated. Import it before the app so `attachShadow` is patched before any
// PI WEB component creates its shadow root.
installPluginStyleSink();
