# Theme styling contract

Themes can change presentation without changing the meaning or behavior of controls. This contract covers conversation messages, renderer/completion choices, project/workspace/session navigation rows, composer controls, and popup/menu anatomy. Other selectors, palette properties, and layout details remain experimental.

## Compatibility and ownership

The hooks listed below are supported styling interfaces. Keep them available and preserve their documented meaning when refactoring components. Additive hooks are compatible; replacing or removing a supported hook requires an explicit compatibility migration rather than silently changing the markup. This contract does not freeze the appearance, dimensions, unlisted tag names, or unrelated DOM structure.

Three responsibilities compose:

- **Primitive:** generic control anatomy and state, such as a choice and whether it is selected.
- **Semantic context:** what the surface represents, such as renderer views or a user message.
- **Theme:** colours, spacing, alignment, borders, and decorative cues.

These are responsibilities, not a requirement for two DOM elements around every control. Use an existing container for context; a domain hook can also live on the control itself. Native semantics, accessible names, event handling, and focus management belong to the component, not CSS.

Base defaults for these surfaces live in the `pi-web-base` cascade layer. Ordinary unlayered contributed CSS overrides them. Scope rules to the host or documented context: contributed sheets reach multiple shadow roots, but selectors do not cross a shadow boundary. Inherited custom properties can cross it. See [theme architecture](theme-architecture.md) and [stylesheet integration](plugins.md#css-files-and-shadow-roots).

## Conversation messages

Inside `:host(chat-view)`, these hooks identify ordinary user and assistant message surfaces, including their image/code content:

| Hook | Meaning |
| --- | --- |
| `.chat-message` | Outer message surface; owns the border, background, width, and alignment |
| `[data-speaker="user"]`, `[data-speaker="assistant"]` | Speaker identity on that surface; independent of its appearance |
| `.chat-message-content` | Direct child containing the header and body; positioned relative by default |
| `.chat-message-header` | Header inside the content wrapper; contains the accessible speaker label and message actions |
| `.chat-message-body` | Body inside the content wrapper; contains message parts |
| `.chat-message-meta` | Metadata region immediately after the content wrapper; native `hidden` tracks whether it is open |
| `.chat-message-content::before` | Reserved for an optional theme-owned decorative speaker cue; unused by the base theme |

Activity groups, tool-image bundles, tools, and system notices are not conversation bubbles and do not expose `.chat-message`. Do not infer these roles from colours or use the older internal `.user`, `.assistant`, or `.conversation-*` classes as the compatibility boundary.

Themes may change the edge width/style, rounding, padding, and alignment using these hooks. For example:

```css
:host(chat-view) .chat-message {
  border-inline-start-width: 2px;
  border-inline-start-style: dotted;
}

:host(chat-view) .chat-message[data-speaker="user"] {
  max-inline-size: 85%;
  margin-inline-start: auto;
}

:host(chat-view) .chat-message[data-speaker="assistant"] {
  max-inline-size: 85%;
  margin-inline-end: auto;
}
```

### Optional decorative icons

No visible role labels or icons are required. A theme can introduce a decorative icon without adding HTML. Use an empty pseudo-element and a background or mask image, rather than generated text or emoji that may affect accessible names.

This example creates an icon column at the beginning of each message. A theme supplies its own assets and may use a different mask for each speaker:

```css
:host(chat-view) .chat-message-content {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
}

:host(chat-view) .chat-message-content::before {
  content: "";
  grid-column: 1;
  grid-row: 1;
  inline-size: 14px;
  block-size: 14px;
  margin-block-start: 12px;
  margin-inline-start: 4px;
  background: currentColor;
  mask: var(--example-speaker-mask) center / contain no-repeat;
  pointer-events: none;
}

:host(chat-view) .chat-message[data-speaker="user"] {
  --example-speaker-mask: url("./user.svg");
}

:host(chat-view) .chat-message[data-speaker="assistant"] {
  --example-speaker-mask: url("./robot.svg");
}

:host(chat-view) .chat-message-body {
  grid-column: 2;
  grid-row: 1;
}
```

The asset paths are relative to the contributed CSS file. `--example-speaker-mask` belongs to this example, not the core property contract. A theme can resize or shorten a decorative edge using the same pseudo-element instead of an icon. It can remove the cue with `content: none` and restore a one-column layout when alignment or another treatment already distinguishes the speakers. Keep the component's screen-reader speaker labels and interactive header intact.

## Selected choices

| Host | Context container | Choice hook | State |
| --- | --- | --- | --- |
| `:host(pi-web-content-renderer)` | `[data-ui-context="content-views"]` | `button.ui-choice` | `data-selected="true"` or `"false"` |
| `:host(autocomplete-menu)` | `[data-ui-context="completions"]` | `button.ui-choice` | `data-selected="true"` or `"false"` |

The context containers already exist for layout; choices are direct children. `.ui-choice` is a generic styling hook, not a new widget or an opt-in behavior. Renderer choices also use `.ui-button` and retain `aria-pressed`; Raw participates in the same contract. Completion selection identifies the keyboard candidate, not a toggled button, so it does not acquire `aria-pressed` or an invented ARIA selection role.

`data-selected` is the shared presentation state. Components update it with the actual selected view or keyboard candidate; themes must not infer selection from hover, focus, or DOM order. Hover and keyboard selection may coexist on different choices.

`button.ui-choice::after` is reserved for an optional theme-owned decorative selection cue. The base does not generate it. For example, add a short underline without changing the button label:

```css
:host(pi-web-content-renderer) [data-ui-context="content-views"] > .ui-choice {
  position: relative;
}

:host(pi-web-content-renderer) [data-ui-context="content-views"] > .ui-choice[data-selected="true"]::after {
  content: "";
  position: absolute;
  inset-inline: 8px;
  inset-block-end: 2px;
  block-size: 2px;
  background: currentColor;
  pointer-events: none;
}
```

A theme may use a different geometric cue for completions. Keep focus independently visible; selection is not focus. This initial contract adds hooks without changing the existing base selection treatments.

## Sidebar navigation rows

Projects, workspaces, and sessions share row styling hooks while keeping their own data, actions, selection, and tree behavior. Existing containers carry these hooks; there is no extra wrapper or new generic widget.

| Host | Section context |
| --- | --- |
| `:host(project-list)` | `[data-ui-context="projects"]` |
| `:host(workspace-list)` | `[data-ui-context="workspaces"]` |
| `:host(session-list)` | `[data-ui-context="sessions"]` |

The section's `data-collapsed="true"` or `"false"` tracks whether its row list is hidden. A collapsed section retains its heading, but removes its list and rows from the DOM.

### Anatomy

| Hook | Meaning |
| --- | --- |
| `.ui-nav-list` | Existing scrolling list container; may also contain headings, toolbars, and disclosures |
| `.ui-nav-row` | Focusable row and primary activation surface |
| `.ui-nav-row-main` | Direct child containing the row's primary content |
| `.ui-nav-row-label` | Primary label inside the main content; may include existing tree decorations |
| `.ui-nav-row-meta` | Secondary information inside the main content; optional for workspaces |
| `.ui-nav-row-leading` | Optional activity/unread mark inside the main content |
| `.ui-nav-row-actions` | Direct child containing the independent secondary action |
| `button.ui-nav-row-action` | Native action-popup trigger; retains `.ui-button` styling |
| `.ui-nav-row-menu` | Associated native popover; locate it through the trigger's `aria-controls`, not DOM nesting |
| `button.ui-nav-row-disclosure` | Optional agent-subsession disclosure immediately after its owning session row |
| `button.ui-nav-section-toggle` | Existing section disclosure; also used for the archived-session subsection |

Only the two main/actions child boundaries are shared across row kinds. Do not depend on a particular nesting between a label, metadata, or status mark and the main content. Lists may contain non-row elements between rows.

Session action popovers live outside the row scroller; project/workspace popovers currently live inside their rows. All remain in their owner's shadow root. The popup trigger's `aria-expanded` tracks its open state; `aria-controls` identifies the popup when rendered. The ID format is not part of the styling contract.

The row itself remains the primary activation surface, not a button enclosing secondary buttons. Existing Enter/Space activation and arrow-key navigation stay component-owned. Metadata can contain independently interactive plugin content. These hooks do not turn the list into an ARIA tree or listbox.

### State

Boolean presentation attributes use the strings `"true"` and `"false"`, except optional `data-expanded` as noted below.

| State | Scope and meaning |
| --- | --- |
| `data-current` | All rows: currently navigated project, workspace, or session. The current row also has `aria-current="true"`; other rows omit it |
| `data-activity` | All rows: `idle`, `session`, `terminal`, or `sending`, matching the existing activity indicator's resolved kind |
| `data-busy` | All rows: session/sending activity, or workspace deletion in progress. Terminal presence and unread alone do not mean busy |
| `data-unread` | All rows: the existing unread indication; project/workspace values come from their rolled-up snapshots, session values concern that session |
| `data-selected` | Session rows: checked for a bulk action, distinct from navigation's `data-current` |
| `data-selecting` | Session rows: a bulk-selection checkbox is currently shown for this row |
| `data-archived` | Session rows: the session is archived, including archived ancestors shown in a current tree |
| `data-expanded` | Session rows with an agent-child disclosure: `"true"` or `"false"`, synchronized with that button's `aria-expanded`. Omitted on other rows |

Projects and workspaces do not acquire synthetic bulk-selection states. Archived sessions and deleting workspaces are not disabled navigation rows. Busy means work is underway, not that navigation is blocked. Existing native `:disabled` controls and `:checked` checkboxes remain the interaction authority; focus and hover use native pseudo-classes and never determine current/selected state.

A session disclosure may show its own aggregate child-attention mark. That does not change the parent row's own activity/unread attributes. Pending-session status placeholders are not navigable rows and do not expose `.ui-nav-row`.

Base defaults for these surfaces, including session-specific row styles, use `pi-web-base`. For example, an ordinary contributed sheet can compose context and anatomy without matching implementation selectors:

```css
:host(workspace-list) [data-ui-context="workspaces"] .ui-nav-row-label {
  text-decoration: underline;
}

:host(session-list) .ui-nav-row[data-current="true"] .ui-nav-row-meta {
  color: var(--pi-text);
}
```

These hooks do not freeze dimensions, indentation formulas, decoration glyphs, or the whole sidebar DOM. Machine rows, session-tree navigation, and bulk toolbars remain outside this contract. Popup controls have their own boundary below; richer workspace detail content is not frozen.

## Composer controls

Inside `:host(prompt-editor)`, the existing footer carries `[data-ui-context="composer"]`. This is the context for the toolbar and its attachment control, not a replacement editor component. Shared `.ui-button` controls keep native events, names, disabled states, and focus behavior.

### Anatomy and purpose

| Hook | Meaning |
| --- | --- |
| `.ui-composer-toolbar` | Existing toolbar belonging to the composer context |
| `.ui-composer-settings` | Existing bounded model/thinking group inside the toolbar; absent until session status is available |
| `.ui-composer-actions` | Existing direct toolbar child containing submission and Stop controls |
| `[data-composer-action]` | Purpose of a native button; independent of its label, icon, and visual treatment |
| `[data-ui-context="composer-attachment-sources"]` | Existing native attachment-source popover inside the composer context |

Supported action values are `model`, `thinking`, `attach`, `send`, `queue`, `steer`, and `stop`. Attachment-source buttons use `attach-photos`, `attach-camera`, and `attach-files`.

The same primary button changes its action from `send` to `queue` while requests are queued; this does not replace the button or move its focus. Steer is present only while offered by the existing session state, and is hidden during compaction. Stop remains a separate button. Themes should target purpose attributes instead of the older internal `.send-button`, `.select-model`, or icon classes.

The attachment button remains in the input area, outside the toolbar. The attachment popover has a real `aria-controls`/`aria-expanded` association only on Android, where that source menu is offered; other platforms use their native file chooser directly, irrespective of pointer type, without inventing a DOM-expanded state. Model and thinking dialogs are owned outside the composer. Their buttons invoke the existing callbacks but do not claim an open/closed state the composer cannot know.

### State

| Attribute | Scope and meaning |
| --- | --- |
| `data-mode` | Composer context: `text` or `shell`, matching actual rendered input mode, including the existing staged-context override of shell mode |
| `data-busy` | Composer context: `true` or `false` for client submission/upload or staged-context acknowledgement in progress, not agent streaming |
| `data-disabled` | Composer context: `true` or `false` for owner-disabled message editing/submission; distinct from pending work |
| `data-compacting` | Composer context: `true` or `false` for session compaction state; queueing can remain available |
| `data-default-action` | Composer context: `send`, `queue`, `steer`, or `none`, the configured eligible submission target |
| `data-default` | Submission/steering buttons: `true` or `false` for whether this is that configured target |

None, invalid/multi-combination submission shortcuts, and blocked submission produce `data-default-action="none"` and no `data-default="true"` button. The existing colour highlight follows the same state. Desktop versus touch/narrow preferences use the same media query as keyboard routing; media changes refresh the hook without replacing the editor or stealing focus.

The configured target does not promise that every keystroke submits a message: an empty draft may be a no-op, completions can consume Enter, and IME/browser processing remains editor-owned. Buttons are not toggles, so default state does not add `aria-pressed`.

Inspect each native `:disabled` state rather than treating either root attribute as a disabled fieldset. For example, Stop may remain usable during client submission, model/thinking callbacks remain externally owned, and a pending submission may still allow editing the next draft. A parent-disabled composer is not falsely reported as busy.

Submission/steering buttons reserve `::after` for an optional theme-owned decorative default cue. The base theme leaves it empty; Playground adds a short underline:

```css
:host(prompt-editor) .ui-composer-actions > [data-default] {
  position: relative;
}

:host(prompt-editor) .ui-composer-actions > [data-default="true"]::after {
  content: "";
  position: absolute;
  inset-inline-start: calc(50% - 5px);
  inset-block-end: 4px;
  inline-size: 10px;
  border-block-end: 2px solid currentColor;
  pointer-events: none;
}
```

Keep focus distinct from the default cue. This boundary does not freeze CodeMirror internals, input sizing, draft storage, chip/attachment rendering, external dialog DOM, or the whole footer structure.

**Known keyboard limitation:** CodeMirror's Android input path can normalize modified Enter to a newline before composer key handlers run. The toolbar contract does not replace that input path. If affected, use a different configured key combination or the submission button. Browser contract tests use a modified letter chord on all engines; existing component tests cover Enter routing independently.

## Popups and menu controls

Popup presentation and menu-item presentation are separate. A completion list, a horizontal message-action strip, and a column of actions can all use native anchored popovers without becoming the same layout or ARIA widget. No new wrappers are required.

| Hook | Meaning |
| --- | --- |
| `button.ui-popup-trigger` | Existing native trigger for an application-owned popup |
| `.ui-popup-panel[popover]` | Existing native top-layer panel, retained in its owner's themed root |
| `.ui-menu` | Optional single-column menu surface, not required on every popup |
| `button.ui-button.ui-menu-item` | Native action or destination choice inside that surface |
| `label.ui-menu-item` containing a checkbox | Native checkbox option, not a synthetic menu-item widget |
| `.ui-menu-item.danger` | Existing destructive-action treatment; labels and callbacks remain owner-defined |

Panels use these contexts: `project-actions`, `workspace-actions`, `session-actions`, `machine-actions`, `machine-picker`, `composer-attachment-sources`, `message-actions`, and `completions`. The first six use `.ui-menu`. Message actions keep their parent-owned slotted action strip; completions keep their existing `.ui-choice` anatomy and editor-owned anchor. Their contents do not acquire menu-item classes or menu/listbox roles.

### Native state and association

- `aria-expanded` (`true` or `false`) belongs to the trigger; `aria-controls` identifies its panel in the same shadow root. IDs are opaque and may not resolve while a conditionally rendered panel is closed. Nested triggers have independent associations.
- `.ui-popup-panel:popover-open` is the panel's native visibility state. There is no duplicate `data-open` flag. Do not use `aria-expanded` or a theme's `display` rule to force a closed popover visible.
- Native buttons expose `:disabled`, `:hover`, and `:focus-visible`. Checkbox options expose their actual input's `:checked` and `:disabled`; themes can use `.ui-menu-item:has(input:checked)`. A label is not itself a disabled control.
- Workspace trust labels additionally expose `data-busy` (`true` or `false`) while their read/save operation is pending. This does not replace input disabled state or imply that the whole popup is busy.
- Machine-picker destination buttons expose `data-current` (`true` or `false`) and current-only `aria-current="true"`. Current identifies the displayed machine, including the initial fallback when no explicit selection is supplied. Focus, hover, and opening that machine's action popup do not select it. These are not toggle buttons; do not invent `aria-pressed` or a universal `data-selected` menu state.

Android's attachment source button gets `.ui-popup-trigger` only when it owns the source popover. Other platforms retain their direct native file chooser and the separate `data-composer-action="attach"` hook, without advertising an application-popup association. Completion anchors remain editable controls, not fabricated trigger buttons.

Supported surface/trigger presentation defaults use `pi-web-base`, so ordinary theme rules can change borders, rounding, colours, item treatment, and optional decoration without `!important`. For example:

```css
.ui-popup-panel.ui-menu { border-radius: 0; }
.ui-menu-item:disabled { text-decoration: line-through; }
.ui-menu-item:has(input:checked) { font-weight: 600; }
[data-ui-context="machine-picker"] .ui-menu-item[data-current="true"] {
  font-weight: 600;
}
```

Machine-picker buttons reserve `::after` for an optional theme-owned current cue. Playground draws a short logical-start edge inside existing padding, without adding a gutter. Destructive menu labels gain a dotted underline. Neither cue replaces names, native state, or focus indication; established themes retain their appearance.

The controller still owns fixed positioning, layout bounds, width/height constraints, native top-layer order, dismissal, and modal ownership. Above-editor completions anchor to the stable application layout rather than the keyboard's visible viewport; other popup placements retain their viewport constraints. Themes must not replace those with stacking numbers or override its inline positioning. Tab/arrow behavior stays with each owner: this contract does not turn every action panel into an arrow-key ARIA menu, add a focus trap, or change completion focus preservation. Escape still closes the innermost popup first and returns focus according to that owner's existing behavior.

This boundary does not freeze all popup contents, machine-row layout, workspace detail structure, glyphs, or native OS chooser UI.

## Accessibility and verification

Themes may replace a cue, rather than display every possible cue. Speaker identity and meaningful states should remain visually distinguishable without hue alone. Small, restrained geometric cues can do this without repeated labels or prominent icons. Do not remove the only distinction unless another treatment replaces it.

Preserve readable contrast, accessible names, focus indicators, native hidden/disabled states, usable targets, and document reading order. Decorative pseudo-elements must not intercept clicks or convey information unavailable from component semantics. Check forced colours as well as colour-vision simulations; background images and masks may disappear in forced-colour modes, so provide a structural fallback where needed.

DOM tests protect the hooks and state synchronization. Browser tests exercise theme overrides, decorative masks, alignment, and removal against real components at desktop and touch viewport sizes. These checks establish a styling boundary, not certification of every custom theme. Other navigation surfaces and the rest of the UI can adopt further contracts after their shared anatomy has been exercised.
