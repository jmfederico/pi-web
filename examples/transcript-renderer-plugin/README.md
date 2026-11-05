# Transcript renderer example

A presentation-only browser API v5 plugin for PI WEB. It replaces matching transcript entries with a compact check-results card or task-status notice, using the host's HTML template tag and theme tokens.

**Requires an unreleased development build** exposing browser API v5 and the `pi-web/transcript-rendering@1` capability. Installing the latest published package alone may not provide this API. The package's `*` development dependency is not a compatibility guarantee; use a matching development package when building.

## Build and install locally

From this directory, install dependencies against your development build, build the browser assets, and link the package into PI WEB's plugin directory:

```sh
npm install --no-save /absolute/path/to/pi-web-development-package
npm run build
mkdir -p "${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins"
ln -s "$PWD" "${PI_WEB_DATA_DIR:-$HOME/.pi-web}/plugins/example-transcript-renderer"
```

Use a directory containing a built PI WEB package, or its packed tarball, for the install path. The link name must not conflict with another plugin.

Reload the browser after installing or rebuilding. This browser-only package has no server entry and needs no session-daemon restart.

The standalone build compiles `src/index.ts` to `browser/index.js` and copies `src/styles.css` to `browser/styles.css`. Only that browser directory is served as plugin assets.

## Synthetic entry contracts

These names and schemas are examples, not built-in PI WEB tools or message types. A separate producer or test fixture must already supply matching transcript entries. This plugin never executes a command, registers a tool, or provides a workspace/provider backend.

| Target | Payload |
| --- | --- |
| Tool `example_checks` | `details: { checks: [{ name: string, status: "passed" \| "failed", durationMs?: number }], durationMs?: number }` |
| Custom message `example.task-notice` | `details: { title: string, status: "completed" \| "failed", summary: string }` |

Names and titles must be nonblank; durations must be finite, nonnegative numbers. Empty check lists are valid. Malformed details return `undefined`, preserving the host's default presentation.

The tool card shows counts, named results, optional timings, and a pending/running state before details arrive. Its native **Command and output** disclosure displays `args.command` when it is a nonblank string and `resultText` when supplied. Args can be an object or valid JSON encoding that object; malformed args are ignored. Text is interpolated through the host template tag, never evaluated or inserted as raw HTML.

## Presentation boundary

The example contributes two tool resolvers followed by one custom-message renderer. Tool contributions use `{ id, target: "tool", resolve(toolName, next) }`, with no declarative `toolName` field. The first resolver in discovery order gets first refusal. Both example resolvers choose the exact name `example_checks` and return `next()` for any other name.

The first resolver calls `next()` to obtain the downstream checks renderer, then wraps its body with a small “Rendered by the example plugin” notice. The second returns the checks renderer itself: `{ render(input) { … } }`. This exercises a real chain in the same contribution array without changing the producer schemas.

Resolvers can **delegate** with `return next()`, **replace** by returning their own renderer without calling `next()`, or **wrap** by calling `next()` and decorating `downstream.render(input)`. The downstream result of `next()` is a renderer object, not HTML. Returning `undefined` from a resolver ends selection; it does not automatically try later resolvers. The web transcript supplies the core default renderer at the end of the chain, so wrappers can also decorate normal tool cards. Delegating unchanged to that default keeps the normal view without a custom-view toggle. The resolver type permits `undefined` in contexts without a supplied default, so the example guards against an absent downstream renderer. Returning `undefined` from resolution or rendering shows the core fallback without restarting selection.

Custom-message contributions retain `{ id, target: "custom-message", customType, render }`. The first eligible exact, case-sensitive `customType` match in discovery order wins, with no `next` callback and no retry after decline or failure.

Both tool and message renderers supply their entire body rather than decorating the default tool/message frame. `render({ scope, entry, signal, fail })` synchronously returns a Lit `TemplateResult` or `undefined`. Returning `undefined` from rendering uses the default view without restarting selection; the wrapper propagates this result instead of showing its notice alone. An empty template intentionally shows an empty body. All callbacks are synchronous and perform no fetching or background work.

The stylesheet contribution resolves its URL relative to the emitted browser module. All rules are plugin-prefixed within `@layer pi-web-base`, and colors/fonts use `--pi-*` tokens. The transcript host already participates in stylesheet integration; this plugin needs no extra shadow root registration, Lit runtime import, or custom components.

See the [plugin guide](https://pi-web.dev/plugins) for plugin discovery and the public API. The source imports public types only from `@jmfederico/pi-web/plugin-api`.

## Isolated preview and screenshots

From the PI WEB repository root, with development dependencies and Playwright Chromium installed:

```sh
npm exec -- vite build --config test-fixtures/browser/vite.config.ts
node test-fixtures/browser/capture-transcript-example.mjs
```

The capture script starts a temporary preview on `127.0.0.1:8526`, loads this example in the real transcript component with synthetic data, and closes the browser and server afterward. It writes dark, expanded light, default-fallback, and narrow-screen screenshots to `/tmp/pi-web-transcript-example`; pass an output directory as its first argument to change that location. No session daemon or tool execution is involved.

Run the example's browser interaction check with `npm run test:browser -- test-fixtures/browser/transcript-example.spec.ts`.
