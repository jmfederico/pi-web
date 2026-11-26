# Dependency holds

This file lists npm dependencies that are deliberately left on an older version. The automated dependency update skips a held dependency until a version newer than the one tried here is published, unless the entry says to keep it.

When a hold is resolved, remove its entry in the same change that upgrades the dependency.

| Dependency | Current | Tried | Status | Reason |
| --- | --- | --- | --- | --- |
| `typescript` | `^6.0.3` | `7.0.2` | Retry with a newer `typescript` or `typescript-eslint` | `typescript-eslint` 8.74.0 requires `typescript >=4.8.4 <6.1.0`, so npm cannot resolve the install. |
| `typescript-eslint` | `^8.71.2` (locked 8.71.2) | `8.74.0` | Retry with a newer version | `npm run lint` reports 29 errors: 19 from the new `@typescript-eslint/no-unsafe-class-instance-assignment` rule (object literals used as `ModelRegistry` and other class instances, mostly in tests and server routes) and 10 from wider `@typescript-eslint/no-deprecated` detection (the `refreshFiles` compatibility alias, and Vite `rollupOptions`/`manualChunks` in `vite.config.ts` and `test-fixtures/browser/vite.config.ts`). Upgrading requires code changes. |
| `@codemirror/view` | `6.43.13` | `6.44.0` | Retry with a newer version | Three composer tests fail with `Calls to EditorView.update are not allowed while an update is in progress` (from happy-dom `Selection.collapse`): `PiWebApp.rendering.test.ts`, `PromptEditor.localization.test.ts` and `PromptEditor.shortcuts.test.ts`. |
| `mermaid` | `^12.2.0` (locked 12.2.0) | `12.3.0` | Needs a license review | Mermaid 12.3.0 bundles `elkjs` 0.12.2, which is licensed `EPL-2.0 OR GPL-3.0-or-later` (previously `EPL-2.0`). `scripts/build-plugins.mjs` stops the build until the Mermaid engine license notice is reviewed for the new license. |
| `typebox` (devDependency) | `1.3.27` | — | Keep in step with Pi | Matches the exact `typebox` version that `@earendil-works/pi-coding-agent` depends on, which is the TypeBox Pi provides to extensions. Change it only together with Pi. The server-only `pi-web-typebox` alias is not covered by this entry. |
