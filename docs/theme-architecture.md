# Theme architecture

PI WEB separates component behaviour from a built-in base theme. Selected themes extend the base with CSS, including layout rules, rather than being limited to colour palettes.

**Styling is mostly experimental.** The [initial theme styling contract](theme-styling-contract.md) defines supported hooks for conversation messages, selected choices, project/workspace/session navigation rows, composer controls, and popup/menu anatomy. Outside that boundary, the base theme, visual design, layout, shared classes, theme properties, and internal selectors may evolve between releases. Capability version numbers describe integration methods, not frozen CSS or appearance.

## Ownership

- **Components:** markup, semantic states, event handling, focus management, disclosure state, and scroll controllers.
- **Base theme:** default layout, typography, spacing, control treatments, transcript presentation, responsive arrangements, and CSS feedback for interaction states.
- **Selected theme:** palette properties and optional CSS overrides of base presentation and layout.
- **Feature plugins:** their own domain markup and local styles; plugins register roots with `stylesheet-integration` and opt in to the shared primitive bundle using `{ sharedUi: true }`. The host owns injection, ordering, and cleanup.

The base lives in `src/client/src/theme/base/`. Core components import the style modules their shadow roots need. Plugin roots receive one host-managed shared-UI bundle on opt-in, followed by contributed theme/plugin sheets. The bundle contains controls and file rows, not shell/chat layout. Omit `sharedUi` for roots that only need contributed CSS. The base is bundled with the host and available synchronously, so loading or changing a selected theme does not remove the default layout. There is no network request or new inheritance manifest for the base.

Style modules under `components/` are internal import bridges during migration. Behaviour helpers, such as warning-icon rendering, remain outside the theme.

## Composition and cascade

Base rules use the named `pi-web-base` cascade layer. Default modules compose at the same layer, preserving their source order. Component-local defaults that overlap shared primitives must use that same layer; otherwise even a generic local selector outranks a more-specific primitive hover, heading, or layout rule. Migrated consumers can retain small content-specific style blocks in their component modules within this layer. Selected themes use the existing [CSS stylesheet contributions](plugins.md#css-files-and-shadow-roots), shared across participating document and shadow roots. Ordinary unlayered theme rules outrank normal base rules without specificity escalation or `!important`. A theme can also explicitly append rules to `pi-web-base` when it wants normal specificity and source-order competition within the base.

Dark, Light, and Classic currently extend the same base with palette and semantic appearance properties. A theme may add a second CSS contribution for layout and control overrides. Shared rules can be bundled into that file at build time; runtime `@import` remains unsupported. No additional inheritance resolver is required.

Scope direct rules to the intended host because a contributed stylesheet reaches multiple shadow roots. For example, an experimental theme can narrow the navigation panel, change chat text size, and round shared controls:

```css
:root {
  --pi-font: system-ui, sans-serif;
  --pi-mono: ui-monospace, monospace;
}

@media (min-width: 1181px) {
  :host(pi-web-app) .shell {
    --navigation-panel-size: 280px;
  }
}

:host(chat-view) {
  font-size: 15px;
}

.ui-button--action {
  border-radius: 10px;
}
```

The selectors above are examples against the current implementation, not additional supported public APIs. Use the [theme styling contract](theme-styling-contract.md) for supported conversation, choice, navigation-row, composer-control, and popup/menu hooks. Layout overrides must preserve the arrangements used by navigation state, collapsed panels, and viewport modes. Keep focus indicators, usable targets, reduced-motion support, and readable feedback when changing appearance. Base rules marked `!important` still follow the CSS cascade's important-layer ordering; themes should not use `!important` as a general override mechanism.

## Declarative catalog

Declare themes and light/dark pairs in `package.json` under `piWeb.plugins[]`, with CSS paths relative to `browserRoot`. A theme-only entry needs neither a browser JavaScript module nor a server module. Discovery reads metadata without evaluating package code. See the [static package example and migration guidance](plugins.md#css-first-themes).

The backend resolves the default theme and includes its metadata, CSS, and default/enforced policy in the initial HTML. If that default requires legacy browser activation, it delivers Classic while preserving the intended selection. Theme details include the associated light/dark pair, if any; CSS is preloaded for the delivered selection, or both variants for Auto. This keeps Auto a browser-side decision without later metadata discovery. Unrelated themes are omitted. If a browser preference needs another theme, `GET api/theme?themeId=…&auto=…` returns that theme's details and the CSS needed for the requested selection. `GET api/themes` lists the complete enabled inventory only when the user opens theme settings. Theme and pair IDs and pair member references are qualified as `pluginId:localId`. Built-in palettes use this catalog too, preserving their `themes:*` IDs. The server still uses shared package discovery to honor enablement and precedence; scoped delivery avoids capturing unrelated package assets or serializing unrelated theme metadata. Legacy browser-runtime theme contributions remain supported with a deprecation warning; they become available only after browser plugin activation. Remote-machine themes are not part of the app-wide gateway catalog.

Stylesheet URLs carry a package revision in the path: `pi-web-theme-assets/<pluginId>/revisions/<revision>/<path>`. Relative font and image URLs inherit that revision directory, so CSS and its packaged assets can use private, immutable browser caching without a mutable URL serving newer bytes. Scoped responses and the full inventory use private HTTP caching with ETag revalidation, so unchanged metadata and inline CSS need not be resent. Targeted lookups supply data rather than changing preferences: enforcement policy is returned unchanged and applied by browser selection, while fallback palettes remain retrievable. Assets must remain inside `browserRoot`; runtime CSS `@import` is still unsupported.

## Loading and switching

Inline document CSS provides a browser-native loading screen before JavaScript runs. Its background and text use the system colours `Canvas` and `CanvasText`, with an independent `color-scheme: light dark`; applying a theme does not recolour the loader. The PI WEB mark uses teal on stable deployments and the same purple as the dev brand assets on development deployments, with a gently pulsing glow. There is no visible loading text, but the status has an accessible loading label, and the glow stays static for reduced-motion preferences. Browser chrome keeps its default colour until a theme commits. This is not the selected theme's exact palette. An early module prepares the document-delivered palette alongside the dynamic application import. Accepting the backend's default requires no additional theme request. The application then reads the browser's desired preference and requests another theme only if its details are not already available. Sources already delivered are reused by the same stylesheet registry. If initial theme data is unavailable, `GET api/theme-bootstrap` supplies the backend default asynchronously. There is no parser-blocking external bootstrap script or render-blocking theme link.

HTML enrichment has a one-second deadline and a 2 MiB serialized-data budget. If discovery or CSS cannot be supplied within those bounds, the shell is still delivered and the client fetches the default asynchronously. Production HTML serving and Vite's development HTML hook use the same bootstrap envelope and safe JSON serialization.

The application is revealed after the delivered palette is prepared and the application has rendered. Browser overrides and legacy plugin activation do not keep the application hidden: the delivered palette remains usable while they load. Initial stylesheet failures reveal the rendered app with its browser-native base colours. If the application module itself fails, the loading screen shows a reload message.

The intended preference is separate from the delivered appearance. A backend default that needs legacy activation is preserved as the preference while Classic provides the initial appearance. Browser overrides still honor configuration enforcement. Theme-data responses do not mutate configuration policy or browser preferences. CSS delivered with the document passes through the same size limits, import policy, asset-URL resolution, compilation, and atomic publication as fetched CSS; it is not a second style owner. An unavailable or failed browser preference leaves the committed palette in place. A legacy theme replaces it when browser plugin activation makes that theme available. The existing localStorage key `pi-web-app-theme` and `{ themeId, auto }` value are unchanged. No arbitrary CSS is cached in localStorage and no new configuration file is introduced; [configuration precedence](config.md#theme-default-and-device-choices) is unchanged.

The browser resolves its desired override with an ordinary targeted fetch when needed; legacy runtime themes become available through browser plugin activation. SettingsDialog owns the full picker inventory request as ordinary settings data: it fetches once on the first General visit per dialog instance, owns loading/error/retry state, and passes successful static metadata to the host registry. A failed listing leaves the current theme and browser preference intact and retries only on request. HTTP caching handles reuse across dialog instances; plugin declaration changes require a browser reload.

The stylesheet registry has two publication boundaries backed by one file cache:

- Ordinary plugin stylesheets publish independently as files become ready.
- A selected theme publishes all its files together. Until then, the last committed theme remains visible, or the startup palette if none has committed. Publication updates every registered root, then theme identity, colour scheme, file-icon scheme, and browser toolbar colour in the same synchronous turn.

Failed theme files leave the committed palette intact and report an error. A later publication can retry. A superseded request or disconnected application cannot commit late. Removing the active theme's contribution removes its CSS and legacy token overrides immediately; it is not retained as a loading placeholder after its owner disappears. New roots receive the committed sheets, never a partially prepared theme. Both publication boundaries preserve the stylesheet `order` and qualified-ID cascade ordering.

## Current boundary

The base owns shared controls, forms, dialogs, settings/notice patterns, file rows, navigation lists, the application/workspace shell, composer, transcript, formatted text, code frames, and notification styling. The default responsive shell is part of the base, not of the palette plugins.

The composer includes a narrow unlayered CodeMirror integration stylesheet. CodeMirror injects unlayered defaults, so placing its font, padding, caret, and selection overrides in the base layer would make those defaults win regardless of specificity. The integration remains theme-owned and uses theme properties; the surrounding composer layout stays in `pi-web-base`. Plugin fallback selectors must exclude shared UI classes so generic local rules do not override layered primitives.

Specialised styles embedded in individual components and feature plugins have not all moved. Those unlayered local rules continue to use the ordinary cascade; theme precedence over them is not guaranteed. Move remaining presentation incrementally, keeping behaviour in its owning component. Do not wrap composed base modules in another `pi-web-base` layer: that creates a nested layer with different precedence.

The base is always present for now. Themes extend it; independently replacing or disabling the complete base is not yet supported. The supported hooks separate primitive state from semantic context without requiring extra wrappers. Project, workspace, and session lists share row anatomy and explicit state hooks; their existing controllers still own navigation, bulk selection, and disclosure behavior. Composer controls expose purpose and configured-default hooks on existing native buttons; editor internals and externally owned dialogs remain separate. Broader selector contracts and supported layout variants can follow once this separation has been exercised in real themes.

## Playground theme

Playground Dark and Playground Light live in the separate, disabled-by-default `playground` plugin under `plugins/playground/`. Source-checkout development installs discover it through the checkout's `plugins/` directory; the published npm package contains neither the plugin nor its assets. No build flag or production runtime switch is needed.

If the development services started before the checkout's `plugins/` directory existed, restart the web/API service and session daemon once to refresh their discovery roots. Restarting the daemon interrupts active sessions and terminals.

In a development install, enable `playground` in **Settings → Plugins**, reload the browser, then choose Playground Dark or Light under **Settings → General → Theme**. Auto follows the device's light/dark preference. The theme IDs are `playground:playground-dark` and `playground:playground-light`; an earlier development choice using `themes:playground-*` must be selected again. Established themes and their IDs are unchanged.

The Playground palettes start from the current PI WEB palettes, with stronger contrast for accent text in dark mode and status/syntax colours in light mode. A separate shared `playground.css` owns the experiments: a small `>` chevron for user messages and `<` for assistant messages, an underline on the selected renderer, a small edge on the selected completion, a short underline on the composer's configured default submission action, an inset edge on the current machine-picker destination, and dotted underlines on destructive menu labels. The CSS-drawn 6×10px chevrons sit beside the first line, inside the normal text inset. Message borders sit flush with the chat edge, without an extra gutter. They add no text column or wrapping indentation. The original coloured message borders remain as a supplementary role cue. Placement follows the inline edge in RTL layouts, while the sent/received shapes keep their meaning. These use the [supported styling hooks](theme-styling-contract.md) without visible speaker labels, icon assets, or extra HTML. Chevrons use the system foreground in forced-colour modes, while selection markers use borders.

Keep future experiments in the Playground files rather than the shared base or established palettes. Playground's appearance may evolve; opting into it is not a promise of a frozen design or accessibility certification. Promoting it to the default would be a separate decision, not an automatic migration of existing preferences.

## Verification

Tests protect base-layer containment, stylesheet adoption and removal, theme selection, and plugin compatibility. Real-browser checks are needed for cascade behaviour, responsive geometry, focus visibility, and theme switching. DOM-only tests do not establish visual layout.
