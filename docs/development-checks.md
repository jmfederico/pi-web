# Development and delivery checks

Keep the frequent feedback loop focused on application behavior. Compilation and packaging have their own required delivery steps.

## During development

Run the smallest relevant test first:

```sh
npm test -- src/server/plugins/serverPluginRuntime.test.ts
```

Before merging cross-cutting changes, run:

```sh
npm run verify
```

This runs typechecking, lint, unused-code analysis, and the ordinary test suite. Use the [testing guide](../.agents/skills/testing-guide/SKILL.md#decide-whether-a-test-adds-protection) to decide which behaviors merit automation and choose their smallest sufficient boundary.

## Before delivery

```sh
npm run build
npm run check:artifacts
```

`check:artifacts` consumes the current `dist` output; it does not build or refresh it. Always run the build first after changing source or packaging inputs. Artifact checks cover emitted public declarations, package contents, deployment-relative client URLs, and plugin bundle contracts such as self-containment and size limits. They are separate from `npm test` and `npm run verify`.

CI and the publish workflow run artifact checks after their build. On Linux they also run `npm run smoke:package-install`, which checks an actual global installation, public API consumer resolution, native PTY execution, and the [server-only TypeBox boundary](#server-only-typebox). That installed-package boundary is distinct from inspecting build output.

## Standalone To-dos package

`packages/todos` is deliberately outside the root distribution and known-package installer. Root `verify` includes its source typecheck/lint/unused-code checks and ordinary tests. Linux CI runs its separate build/install boundary after the root build; locally run:

```sh
npm run build:todos
npm --prefix packages/todos test
npm run smoke:todos
```

`build:todos` consumes the emitted public host declarations and emits only `packages/todos/dist`. The smoke consumes those artifacts, packs and installs the standalone package into a temporary npm tree with suppressed automatic peers, explicitly links the current built host peer, and verifies its browser graph, persistent SQLite server, native companion discovery and a temporary standalone source build against declared peers. The separate root `smoke:package-install` still owns the complete installed host. Do not install into live profiles to run these checks. See the [package guide](../packages/todos/docs/usage.md) for supported setup and current slice limitations.

## Server-only TypeBox

`pi-web-typebox` is an npm alias for the ordinary `typebox` package, pinned to the server's existing version. It is not a fork or vendored copy.

PI WEB has two execution environments: its `/pi-web` extension runs inside Pi, while its CLI and session daemon run independently. Pi supplies TypeBox to extensions through its module mapping, but that mapping is not available to a standalone Node process. Depending on Pi's private TypeBox files or npm hoisting would make server resolution depend on the installation layout. Making TypeBox peer-only is also insufficient: Pi-managed installs suppress automatic peer installation.

Pi warns when an extension package lists `typebox` in `dependencies`, even if only its standalone server imports it ([#277](https://github.com/jmfederico/pi-web/issues/277)). The server-only alias retains an explicit runtime dependency without triggering that extension diagnostic. Server tool schemas and their tests import `pi-web-typebox`; code under `extensions/` must not import this alias or the server tools. Extensions that need TypeBox should use Pi's host-provided `typebox` instead.

The installed-package smoke checks native Node schema creation/validation and imports all three built server tool modules after a normal global npm install. It also installs the tarball with Pi's `--legacy-peer-deps` policy and verifies native alias resolution without the Pi SDK peer present. Both installations load `/pi-web` through the real Pi resource loader with no dependency warning. The managed check covers TypeBox, not standalone provisioning of the server's separate Pi SDK peers.

Revisit the alias if Pi introduces a supported way to distinguish standalone runtime dependencies from extension dependencies. Until then, keep the explicit server dependency and preserve these installation checks rather than moving it to peers or relying on an undeclared transitive dependency.

