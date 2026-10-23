# Development and delivery checks

Use focused checks for local feedback; use CI and delivery gates for broad confidence. Pick checks by the boundary changed, not by a habit of running every command before every handoff.

For incremental chat UX changes, see [composing chat behavior](chat-behaviors.md) for capability ownership and internal configuration.

## Fast local feedback

While editing, run the test that proves the changed behavior. For example:

```sh
npm test -- src/shared/themePreference.test.ts
```

For a large test file, add `-t <test-name-pattern>`. For an interactive edit/test loop, keep the runner alive:

```sh
npm exec -- vitest watch --config vitest.config.ts src/shared/themePreference.test.ts
```

When the affected tests are not obvious, use import-based selection:

```sh
npm exec -- vitest related --run --config vitest.config.ts src/shared/themePreference.ts
```

Related-test selection follows imports. Explicitly include tests for files read at runtime, such as Docker assets, package metadata, generated output, or documentation. If no tests are selected, identify a relevant test or report the coverage gap instead of treating an empty selection as a pass.

Known runtime-read asset owners include the Docker tests under `src/docker/`, `src/server/dockerControlAssets.test.ts`, and `src/server/dockerDev*.test.ts`; plugin/package metadata checks in `pi-web-plugins/pluginPublicApi.test.ts` and each package's own tests; and website checks in `scripts/docs-site.test.mjs`. Docker documentation is covered by `src/docker/piWebDockerDocs.test.ts`. Choose the relevant owner rather than running all of them for every asset edit.

Run the completion checks once against the final changes before committing or handing off a completed code batch. If relevant files change afterward, rerun the affected checks; committing alone does not invalidate an earlier result. For TypeScript code changes, run the relevant tests, lint only the changed TypeScript files, and use the cached whole-project typecheck:

```sh
npm exec -- eslint src/shared/themePreference.ts src/shared/themePreference.test.ts
npm run typecheck:cached
git diff --check
```

The first cached typecheck still pays for a full check; subsequent runs reuse `node_modules/.cache/pi-web/typecheck.tsbuildinfo`. Scoped ESLint is type-aware and still loads the TypeScript project, so it belongs at a meaningful checkpoint rather than after every keystroke. Focused tests/watch mode are the innermost loop.

Documentation/comment-only changes need link/path review, relevant documentation or asset tests, and `git diff --check`; they do not need a local typecheck or whole-project lint. Use the [testing guide](../.agents/skills/testing-guide/SKILL.md#decide-whether-a-test-adds-protection) to choose the smallest boundary that proves the behavior.

## Browser surface contracts

For popup, modal, or conversation-boundary changes, run the isolated component browser suite:

```sh
npx playwright install chromium firefox webkit
npm run test:browser
```

On Linux, browser system libraries may also be needed; Playwright documents missing dependencies when a browser cannot launch. CI installs them with `npx playwright install --with-deps chromium firefox webkit`.

The suite builds an isolated component fixture into `node_modules/.cache/pi-web/browser-fixture` and starts its own Vite preview server on `127.0.0.1:8516`. It uses fake completion data and does not start or connect to a session daemon. It does not rebuild the published app or use the running development server. It covers Chromium, Firefox, WebKit, and a touch/mobile Chromium profile. Use `npm run test:browser -- --project=chromium` for focused iteration. Failure traces are written under `test-results/` and can be opened with `npx playwright show-trace <trace.zip>`.

These tests prove browser painting, hit targeting, anchoring, and focus/dismissal composition; happy-dom tests remain responsible for component event wiring and state. They are a separate CI job, not part of `npm test` or `npm run verify`.

## Check ownership

| Stage | Required checks | Where they run |
| --- | --- | --- |
| Local iteration | Focused tests, optionally in watch mode | Developer/agent workspace |
| Local completion | Relevant tests; scoped ESLint and cached typecheck for TypeScript changes; diff/link checks as applicable | Developer/agent workspace |
| Commit | `git diff --cached --check` only, through the pre-commit hook | Local workspace after `npm install`/`npm ci` configures `.githooks` |
| Pull request | `npm run verify`, build, artifact checks; browser surface contracts in a separate Linux job | GitHub Actions CI, Linux and Windows |
| Merge/push to `main` | Same full CI and browser checks; installed-package smoke on Linux | GitHub Actions CI |
| Manual CI run | Same full CI checks; installed-package smoke on Linux | GitHub Actions `workflow_dispatch`, selected ref |
| Package publication | Full verification, build, artifact checks, installed-package smoke, then publish | GitHub Actions publish workflow, Linux |

Pre-commit checks only the staged diff for whitespace errors and introduced conflict markers. It starts no npm/Node process and runs no typecheck, lint, Knip, tests, or build. The former `verify:staged` command and staged-validation planner have been removed. Agents choose and run the scoped completion checks explicitly, then commit without repeating them. A successful commit proves hygiene only; CI independently checks the code.

`npm run verify` runs uncached typechecking, whole-project ESLint, Knip unused-code analysis, and the ordinary test suite. Run it locally when a change's affected surface cannot be bounded, validation configuration changes, or a user explicitly requests full verification. A shared helper with identifiable consumers can still use related tests; a final handoff alone is not a reason to rerun every check. CI provides the mandatory broad PR/merge gate.

Report the exact commands and scope actually verified. A focused test run is not a full-suite pass, and local results do not replace checking the CI result.

## Scoped delivery checks

For changes to emitted declarations, public exports, package contents, plugin bundles, or deployment-relative URLs, run:

```sh
npm run build
npm run check:artifacts
```

`check:artifacts` consumes the current `dist` output; it does not build or refresh it. Build first after changing source or packaging inputs. Artifact checks cover emitted public declarations, package contents, deployment-relative client URLs, and plugin bundle contracts such as self-containment and size limits. They are separate from `npm test` and `npm run verify`.

Ordinary application-logic changes can use focused local tests without building the package. PR/main CI still builds and checks artifacts for every change, so local scoping does not remove the delivery safety net.

## Installed-package smoke: what it buys

```sh
npm run build
npm run smoke:package-install
```

Unlike ordinary tests or artifact inspection, the smoke test packs the existing build, installs the tarball with npm 12 into isolated temporary directories, and exercises the installed package. It checks installed dependency resolution and runtime behavior without source aliases. Some fixture tooling still comes from the checkout: TypeScript, Node typings, and the Pi resource loader. It is not a wholly independently provisioned consumer.

| Installed boundary | Protection |
| --- | --- |
| Shared Pi runtime | Independently installed Pi versions supply the SDK to fresh PI WEB CLI processes and server module checks. Isolated session daemons start, report the selected Pi version, and stop cleanly. PI WEB does not provision its own SDK. |
| Standalone server TypeBox | Native Node creates/validates schemas through the declared `pi-web-typebox` alias and imports the built server tools without Pi's module mapping or Vitest transforms. |
| Pi-managed install | A separate `--legacy-peer-deps` installation omits automatic SDK peers and uses the selected existing Pi installation to load the CLI and server tool modules. |
| Pi extension loading | The real Pi resource loader loads the installed `/pi-web` extension in both install layouts, registers its command, and reports no dependency warnings. |
| Public plugin API | Strict browser/server consumer and example compilations resolve installed public entries under NodeNext and Bundler; unsupported deep imports are rejected and emitted session-bridge entries import successfully. |
| Shipped plugin behavior | The installed Captain's Log translator uses real Pi sessions/extensions with fake model streaming to check read-only source access, translator-session reuse, failure recovery, reconnects, and persisted archive records. |
| Native terminal | The installed stable `node-pty` and terminal service execute a real shell command, capture its output, and exit successfully. |

This catches missing packaged files, bad exports, undeclared or incorrectly resolved dependencies, peer-install-policy differences, resource-loader incompatibility, and native PTY/install-script failures that can pass in a development checkout. It does not replace application tests, install user services, verify full HTTP/WebSocket interactions or host admission, exercise browser rendering/live model calls, or test every supported machine/platform. Captain's Log archive recreation is covered; process-crash recovery and reopening an on-disk Pi transcript are not.

Its cost comes largely from downloading/installing npm and runtime dependencies into a fresh temporary cache, unpacking two install layouts, and strict consumer/example compilations. It requires registry access and a POSIX shell. Prefixes, caches, and fixture agent directories are temporary and cleaned up afterward; npm subprocesses get a temporary home. The harness and PTY still inherit the process environment and run with the user's permissions, so this is test isolation rather than a security sandbox. It does not install into the user's global prefix or restart the live session daemon.

### When to run it locally

Run it before merging a change to an installed-package boundary, or to reproduce a smoke failure. Examples include:

- Runtime dependencies, Pi SDK peers, TypeBox resolution, or npm/Pi install policy.
- `package.json` exports/files/bin contracts, packaging/build scripts, or public plugin API resolution.
- Shipped extension loading, built-in extension factories, native `node-pty`/terminal-service integration, or the installed Captain's Log translation/archive contract.
- The smoke script or its fixtures.

For a related change, the smoke command consumes the preceding build; rebuild after changing source or packaging inputs. Routine UI, route, application-logic, documentation, or unrelated test work does not require this command locally.

CI runs it after merges/pushes to `main` and on manual runs, on Linux only. Ordinary PR CI skips it; packaging-sensitive PRs should run it locally before merge or use a manual CI run for their branch. The publication workflow always runs it before publishing. This trades an installed-package check on every PR for a post-merge gate plus a final publication gate, while keeping the normal PR build/artifact checks.

The implementation lives in [`scripts/smoke-package-install.mjs`](../scripts/smoke-package-install.mjs), [`scripts/plugin-api-package-smoke.mjs`](../scripts/plugin-api-package-smoke.mjs), and [`scripts/captains-log-package-smoke.mjs`](../scripts/captains-log-package-smoke.mjs).

## Bun runtime delivery check

After building, run `npm run smoke:bun-install` with Bun 1.4.3 or newer on PATH (or set `BUN_EXECUTABLE` to its absolute path). The check packs a disposable payload copy, installs PI WEB and a separate fixture Pi with Bun, then verifies CLI selection, SDK session/extension loading, both services, HTTP, a real PTY over the paired WebSocket channel, size-specific rejection of valid oversized open/data envelopes on both direct and proxied paths, and clean exit after SIGTERM with a live shell. It also restarts the disposable daemon in recovery safe start to verify that Terminal status changes from active to disabled even though the runtime prerequisites are unchanged. It does not call a model or install user services. State, package-manager caches and prefixes are temporary; application children have no Node/npm on PATH. A machine may still have Node at the launcher's fixed discovery paths, so that test explicitly selects Bun.

Use `PI_WEB_SMOKE_WEB_RUNTIME=node` or `PI_WEB_SMOKE_SESSIOND_RUNTIME=node` to check mixed-runtime deployments. The default daemon transport is a Unix socket; set `PI_WEB_SMOKE_DAEMON_TRANSPORT=tcp` to cover TCP instead. For a genuine Bun-only check, run the script with Bun inside a disposable Linux container that has Bash, git and coreutils but no Node engine, mounting this checkout and its existing dependencies read-only. Set `PI_WEB_SMOKE_PREFERENCE=auto PI_WEB_SMOKE_NODE_ABSENT=1`; this additionally asserts that forced Node selection fails. The main/manual Linux CI gate runs this container check and both mixed-runtime cells. `PI_WEB_SMOKE_TARBALL` can supply an already-built tarball instead of packing the checkout.

Node's receiver can enforce channel payload limits during assembly. Bun's native transport does not expose that control, so shared decoders apply the same application limits after message delivery. Keep the real Bun oversized-frame and teardown regressions; they protect PI WEB's protocol behavior without depending on Bun's private buffer sizes or constructor names.

### Terminal composition and diagnostics

`ptyProvider.ts` defines the behavior consumed by `TerminalService`; `ptyComposition.ts` selects the implementation at activation. Keep runtime choices there rather than in terminal operations. Preflight checks whether the selected runtime's provider prerequisites are available, without activating plugins. Once sessiond is running, `/terminal-status` reports the activated plugin's lifecycle and its own health verdict, including deliberate recovery disablement. Neither check promises that every future operation will succeed; operation failures belong to the owning adapter/service and should be fixed there when discovered.

## Shared Pi runtime

PI WEB reuses the user's existing Pi installation. The `/pi-web` extension gets that installation through Pi's public `getPackageDir()` API and passes it to the CLI as `PI_WEB_PI_PACKAGE_DIR`. Native service definitions retain that selection. Without an explicit selection, ordinary npm SDK resolution takes precedence; if no peer is locally resolvable, standalone commands can find an existing npm-installed `pi` executable on `PATH`. An invalid explicit selection is an error, not permission to silently select a different Pi or install one.

Standalone application code imports SDK values through `src/piSdk.ts` and AI helpers through `src/piAi.ts`. Their shared loader, `src/piRuntime.ts`, resolves the selected installation's public package exports using `import-meta-resolve`. It does not register a Node loader hook, rewrite other modules' imports, or assume private SDK file paths. Pi's own dependencies and extension loader retain their ordinary resolution and module identity. Keep runtime imports behind this boundary; canonical type-only imports are safe because they disappear from emitted JavaScript. The canonical SDK peers are optional with `"*"` ranges, and there is no runtime version gate. Development dependencies support the checkout's tests and typechecking rather than provisioning a published runtime.

Upgrading or downgrading Pi in place takes effect when services restart. If Pi moves to another path, reinstall the PI WEB service definitions from that Pi instance. The startup environment selects an installation, not a frozen copy of its version.

## Server-only TypeBox

`pi-web-typebox` is an npm alias for the ordinary `typebox` package, pinned to the server's existing version. It is not a fork or vendored copy.

PI WEB has two execution environments: its `/pi-web` extension runs inside Pi, while its CLI and session daemon run independently. Pi supplies TypeBox to extensions through its module mapping, but that mapping is not available to a standalone Node process. Depending on Pi's private TypeBox files or npm hoisting would make server resolution depend on the installation layout. Making TypeBox peer-only is also insufficient: Pi-managed installs suppress automatic peer installation.

Pi warns when an extension package lists `typebox` in `dependencies`, even if only its standalone server imports it ([#277](https://github.com/jmfederico/pi-web/issues/277)). The server-only alias retains an explicit runtime dependency without triggering that extension diagnostic. Server tool schemas and their tests import `pi-web-typebox`; code under `extensions/` must not import this alias or the server tools. Extensions that need TypeBox should use Pi's host-provided `typebox` instead.

The installed-package smoke checks native Node schema creation/validation and imports all three built server tool modules against the selected existing Pi installation. It also installs the tarball with Pi's `--legacy-peer-deps` policy. Both installations load `/pi-web` through the real Pi resource loader with no dependency warning; neither requires PI WEB to install another SDK.

Revisit the alias if Pi introduces a supported way to distinguish standalone runtime dependencies from extension dependencies. Until then, keep the explicit server dependency and preserve these installation checks rather than moving it to peers or relying on an undeclared transitive dependency.
