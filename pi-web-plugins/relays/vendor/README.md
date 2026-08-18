# Vendored dependencies

## marked (`marked.esm.js`)

- **Source:** `node_modules/marked/lib/marked.esm.js` — marked v18.0.6, the
  version the repo pins (`"marked": "^18.0.6"` in the root `package.json`).
- **License:** MIT — copyright (c) 2018-2026 MarkedJS, (c) 2011-2018
  Christopher Jeffrey. The attribution header at the top of `marked.esm.js` is
  preserved; see also `node_modules/marked/LICENSE.md`.
- **Why vendored:** bundled plugins load in the browser as standalone ES
  modules and cannot resolve bare package specifiers. The plugin therefore
  ships the exact marked build the repo already depends on, rather than
  hand-rolling a markdown subset or adding a markdown helper to the plugin API.
- **Local modification:** the trailing `//# sourceMappingURL=marked.esm.js.map`
  comment was removed because the (much larger) source map is not vendored.
  Everything else is byte-identical to the published file.
- **`marked.esm.d.ts`** is a hand-written minimal declaration covering only the
  surface `markdownDocument.ts` uses. The plugin build
  (`scripts/build-plugins.mjs`) skips `.d.ts` files and copies `.js` assets
  verbatim, so the vendored module ships as-is.

**Updating:** after a `marked` upgrade in the root `package.json`, copy the new
`node_modules/marked/lib/marked.esm.js` here, re-apply the sourceMappingURL
removal, and update this note.
