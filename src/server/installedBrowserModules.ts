/** Standalone ESM distributions used by the host client. These are exact package
 * exports, not a public node_modules mount or a resolution API for plugins. */
export const installedBrowserModules = [
  { id: "marked", entry: "marked", path: "pi-web-dependencies/marked.esm.js" },
  { id: "css-tree", entry: "css-tree/dist/csstree.esm", path: "pi-web-dependencies/csstree.esm.js" },
];
