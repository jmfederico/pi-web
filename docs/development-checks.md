# Development and delivery checks

Use focused checks for local feedback; use CI and delivery gates for broad confidence. Pick checks by the boundary changed, not by a habit of running every command before every handoff.

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

## Check ownership

| Stage | Required checks | Where they run |
| --- | --- | --- |
| Local iteration | Focused tests, optionally in watch mode | Developer/agent workspace |
| Local completion | Relevant tests; scoped ESLint and cached typecheck for TypeScript changes; diff/link checks as applicable | Developer/agent workspace |
| Commit | `git diff --cached --check` only, through the pre-commit hook | Local workspace after `npm install`/`npm ci` configures `.githooks` |
| Pull request | `npm run verify`, build, artifact checks | GitHub Actions CI, Linux and Windows |
| Merge/push to `main` | Same full CI checks; installed-package smoke on Linux | GitHub Actions CI |
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
| Pi SDK peers | A global install resolves supported Pi 1.x peers, loads the SDK barrels, and finds the three built-in extension factories. |
| Standalone server TypeBox | Native Node creates/validates schemas through the declared `pi-web-typebox` alias and imports the built server tools without Pi's module mapping or Vitest transforms. |
| Pi-managed install | A separate `--legacy-peer-deps` installation omits automatic SDK peers and still resolves server TypeBox. This checks the dependency boundary, not standalone server provisioning without the SDK. |
| Pi extension loading | The real Pi resource loader loads the installed `/pi-web` extension in both install layouts, registers its command, and reports no dependency warnings. |
| Public plugin API | Strict browser/server consumer and example compilations resolve installed public entries under NodeNext and Bundler; unsupported deep imports are rejected and emitted session-bridge entries import successfully. |
| Shipped plugin behavior | The installed Captain's Log translator uses real Pi sessions/extensions with fake model streaming to check read-only source access, translator-session reuse, failure recovery, reconnects, and persisted archive records. |
| Native terminal | The installed stable `node-pty` and terminal service execute a real shell command, capture its output, and exit successfully. |

This catches missing packaged files, bad exports, undeclared or incorrectly resolved dependencies, peer-install-policy differences, resource-loader incompatibility, and native PTY/install-script failures that can pass in a development checkout. It does not replace application tests, start the CLI/session daemon, verify real HTTP/WebSocket transport or host admission, exercise browser rendering/live model calls, or test every supported machine/platform. Captain's Log archive recreation is covered; process-crash recovery and reopening an on-disk Pi transcript are not.

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

## Server-only TypeBox

`pi-web-typebox` is an npm alias for the ordinary `typebox` package, pinned to the server's existing version. It is not a fork or vendored copy.

PI WEB has two execution environments: its `/pi-web` extension runs inside Pi, while its CLI and session daemon run independently. Pi supplies TypeBox to extensions through its module mapping, but that mapping is not available to a standalone Node process. Depending on Pi's private TypeBox files or npm hoisting would make server resolution depend on the installation layout. Making TypeBox peer-only is also insufficient: Pi-managed installs suppress automatic peer installation.

Pi warns when an extension package lists `typebox` in `dependencies`, even if only its standalone server imports it ([#277](https://github.com/jmfederico/pi-web/issues/277)). The server-only alias retains an explicit runtime dependency without triggering that extension diagnostic. Server tool schemas and their tests import `pi-web-typebox`; code under `extensions/` must not import this alias or the server tools. Extensions that need TypeBox should use Pi's host-provided `typebox` instead.

The installed-package smoke checks native Node schema creation/validation and imports all three built server tool modules after a normal global npm install. It also installs the tarball with Pi's `--legacy-peer-deps` policy and verifies native alias resolution without the Pi SDK peer present. Both installations load `/pi-web` through the real Pi resource loader with no dependency warning. The managed check covers TypeBox, not standalone provisioning of the server's separate Pi SDK peers.

Revisit the alias if Pi introduces a supported way to distinguish standalone runtime dependencies from extension dependencies. Until then, keep the explicit server dependency and preserve these installation checks rather than moving it to peers or relying on an undeclared transitive dependency.
