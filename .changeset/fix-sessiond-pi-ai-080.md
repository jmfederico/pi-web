---
"@jmfederico/pi-web": patch
---

Fix `pi-web-sessiond` crash loop against `@earendil-works/pi-ai` 0.80.x.

`@earendil-works/pi-ai` 0.80.x moved the legacy global catalog helpers
(`getProviders`, `getApiProvider`, `getModel`, `getModels`) out of the package
main entrypoint. The main entry (`"@earendil-works/pi-ai"`) no longer exports
`getProviders` / `getApiProvider`, so importing them from there throws at module
instantiation:

    SyntaxError: The requested module '@earendil-works/pi-ai' does not provide
    an export named 'getProviders'

Because `pi-web-sessiond` imports these at startup, the daemon crashed in a
loop and never created its unix socket, surfacing in the UI as:

    Error: connect ENOENT /root/.pi-web/sessiond.sock

Migrate the two affected imports:
- `getProviders` -> `getBuiltinProviders` from the new public
  `@earendil-works/pi-ai/providers/all` entrypoint (non-deprecated).
- `getApiProvider` (no public replacement yet) -> `@earendil-works/pi-ai/compat`,
  the drop-in compatibility entrypoint introduced in pi-ai 0.80.1.

Bump the `@earendil-works/pi-{ai,agent-core,coding-agent}` dev/peer dependency
floor to `0.80.1` so the `compat` and `providers/all` entrypoints are always
available.