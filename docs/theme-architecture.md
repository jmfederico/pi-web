# Theme architecture

PI WEB separates component behaviour from a built-in base theme. Selected themes extend the base with CSS, including layout rules, rather than being limited to colour palettes.

**Styling is experimental.** The base theme, visual design, layout, shared classes, theme properties, and internal selectors may evolve between releases. There is no stable styling contract yet; custom themes may require updates. Capability version numbers describe integration methods, not frozen CSS or appearance.

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

The selectors above are examples against the current implementation, not newly supported public APIs. Layout overrides must preserve the arrangements used by navigation state, collapsed panels, and viewport modes. Keep focus indicators, usable targets, reduced-motion support, and readable feedback when changing appearance. Base rules marked `!important` still follow the CSS cascade's important-layer ordering; themes should not use `!important` as a general override mechanism.

## Current boundary

The base owns shared controls, forms, dialogs, settings/notice patterns, file rows, navigation lists, the application/workspace shell, composer, transcript, formatted text, code frames, and notification styling. The default responsive shell is part of the base, not of the palette plugins.

The composer includes a narrow unlayered CodeMirror integration stylesheet. CodeMirror injects unlayered defaults, so placing its font, padding, caret, and selection overrides in the base layer would make those defaults win regardless of specificity. The integration remains theme-owned and uses theme properties; the surrounding composer layout stays in `pi-web-base`. Plugin fallback selectors must exclude shared UI classes so generic local rules do not override layered primitives.

Specialised styles embedded in individual components and feature plugins have not all moved. Those unlayered local rules continue to use the ordinary cascade; theme precedence over them is not guaranteed. Move remaining presentation incrementally, keeping behaviour in its owning component. Do not wrap composed base modules in another `pi-web-base` layer: that creates a nested layer with different precedence.

The base is always present for now. Themes extend it; independently replacing or disabling the complete base is not yet supported. Stabilising selectors and defining supported layout variants can follow once this separation has been exercised in real themes.

## Verification

Tests protect base-layer containment, stylesheet adoption and removal, theme selection, and plugin compatibility. Real-browser checks are needed for cascade behaviour, responsive geometry, focus visibility, and theme switching. DOM-only tests do not establish visual layout.
