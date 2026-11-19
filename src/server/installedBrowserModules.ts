interface InstalledBrowserModule {
  id: string;
  entry: string;
  path: string;
  /** Resolve a transitive dependency from its owner, even if npm didn't hoist it. */
  parent?: string;
}

const parser = "@formatjs/icu-messageformat-parser";
export const icuModuleDirectory = "pi-web-dependencies/icu/";

// The formatter and parser versions are pinned together. Their published entries
// use these bare imports; only this directory gets an import map in the host HTML.
export const icuBrowserModules = [
  { id: "intl-messageformat" },
  { id: parser },
  { id: "@formatjs/fast-memoize", parent: "intl-messageformat" },
  { id: "@formatjs/icu-skeleton-parser", parent: parser },
].map((module) => ({ ...module, entry: module.id, path: `${icuModuleDirectory}${module.id}.js` }));

/** Exact browser entry points, not a public node_modules mount or resolver for plugins. */
export const installedBrowserModules: InstalledBrowserModule[] = [
  { id: "marked", entry: "marked", path: "pi-web-dependencies/marked.esm.js" },
  { id: "css-tree", entry: "css-tree/dist/csstree.esm", path: "pi-web-dependencies/csstree.esm.js" },
  ...icuBrowserModules,
];
