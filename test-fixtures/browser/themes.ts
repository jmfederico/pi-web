import startupDocument from "../../src/client/index.html?raw";
import { PluginStyleRuntime, pluginStyles } from "../../src/client/src/plugins/styles";
import { beginThemeStartup, claimStartupDocument, revealApplication, themeStartup } from "../../src/client/src/themeStartup";
import type { QualifiedThemeContribution } from "../../src/client/src/plugins/types";
import { applyPiWebTheme } from "../../src/client/src/theme";

// Exercise the real critical CSS against adopted theme sheets, not a mirrored palette.
const parsed = new DOMParser().parseFromString(startupDocument, "text/html");
const critical = parsed.querySelector("style");
if (critical === null) throw new Error("Missing startup CSS");
document.head.append(document.importNode(critical, true));
const registry = pluginStyles;
const runtime = new PluginStyleRuntime(registry, (error) => { console.error(error); });
runtime.connect(document);
if (new URLSearchParams(location.search).has("startup")) {
  document.documentElement.dataset["piWebLoading"] = "";
  const loader = parsed.querySelector("#pi-web-startup");
  if (loader === null) throw new Error("Missing startup loader");
  document.body.append(document.importNode(loader, true));
  beginThemeStartup();
  claimStartupDocument();
  void themeStartup.ready.then(revealApplication);
}
const host = document.createElement("div");
const shadow = host.attachShadow({ mode: "open" });
shadow.innerHTML = '<style>:host { display: block; background: var(--pi-bg); color: var(--pi-text); }</style><span>Shadow theme sample</span>';
registry.registerRoot(shadow);
document.body.append(host);
host.id = "shadow-sample";
for (const id of ["first", "next"]) {
  document.getElementById(id)?.addEventListener("click", () => {
    const theme: QualifiedThemeContribution = {
      id: `fixture:${id}`, pluginId: "fixture", localId: id, name: id, colorScheme: "light",
      stylesheets: [{ id: `fixture:${id}:palette`, url: new URL(`palette-${id}.css`, document.baseURI).href }],
    };
    runtime.updateTheme(theme, () => { applyPiWebTheme(theme); });
  });
}
document.body.dataset["ready"] = "true";
