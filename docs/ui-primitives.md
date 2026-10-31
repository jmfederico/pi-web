# UI primitives

Use shared primitives for new controls. Migrate existing controls as their surfaces are updated; a feature change does not require a whole-app restyle.

Default presentation and layout live in `src/client/src/theme/base/`, in the `pi-web-base` cascade layer. `src/client/src/components/ui/controlStyles.ts` and related style modules are internal import bridges to that base theme. Themes can extend these defaults with contributed CSS; see [theme architecture](theme-architecture.md) for ownership and the current migration boundary. Related modules provide dialog, file-list, and transcript patterns. They style native elements rather than wrapping them in custom elements, so browser focus, disabled state, form behavior, labels, and existing event handlers remain intact.

## Available primitives

| Primitive | Markup | Style export |
| --- | --- | --- |
| Button | `button.ui-button` | `uiButtonStyles` |
| Standalone action | Add `ui-button--action` for a bordered silhouette without elevation; combine with `ui-button--primary` for emphasis | `uiButtonStyles` |
| Compact button | Add `ui-button--compact` | `uiButtonStyles` |
| Small transcript action | Add `ui-button--small`, optionally with `ui-button--icon` | `uiButtonStyles` |
| Icon button | Add `ui-button--icon` and an accessible name | `uiButtonStyles` |
| Primary action | Add `ui-button--primary` | `uiButtonStyles` |
| Native select | `select.ui-select` | `uiButtonStyles` |
| Tabs | `.ui-tabs` with `button.ui-button.ui-tab`; optionally `ui-tabs--primary` | `uiTabStyles`, `uiToolbarStyles`, and `uiButtonStyles` |
| File/tree rows | `.ui-file-list`, `button.ui-button.ui-file-row`, `.ui-file-leading`, `.ui-file-label`, optional `.ui-file-meta`; integer `--depth` | `uiFileListStyles` and `uiButtonStyles` |
| Secondary toolbar | `.ui-toolbar`, with optional `.ui-toolbar-title` and `.ui-toolbar-group` | `uiToolbarStyles` plus `uiButtonStyles` |
| Embedded toolbar without a bottom separator | Add `ui-toolbar--borderless` | `uiToolbarStyles` |
| Primary-size toolbar | Add `ui-toolbar--primary` for 44px controls | `uiToolbarStyles` plus `uiButtonStyles` |
| Bounded control group | Add `ui-toolbar-group--bounded` where a group meets empty bar space | `uiToolbarStyles` |
| Popup surface | `.ui-menu` containing native `.ui-menu-item` controls | `uiMenuStyles` plus `uiButtonStyles` |
| Flat transcript section | `.ui-transcript-surface`; consumer sets `--ui-transcript-bg` and internal padding | `uiTranscriptStyles` from `ui/transcriptStyles.ts` |
| Transcript disclosure | Native `summary.ui-transcript-disclosure` | `uiTranscriptStyles` |

Include the required style exports in the Lit element that owns the shadow root. `listStyles` already includes all three exports for navigation lists. Styles do not cross shadow boundaries automatically.

```ts
import { css, html, LitElement } from "lit";
import { uiButtonStyles, uiToolbarStyles } from "./ui/controlStyles";

class ExampleToolbar extends LitElement {
  static override styles = [uiButtonStyles, uiToolbarStyles, css`
    .label { align-self: center; padding-inline: 10px; }
  `];

  override render() {
    return html`
      <div class="ui-toolbar">
        <span class="ui-toolbar-title label">Files</span>
        <div class="ui-toolbar-group">
          <button type="button" class="ui-button">Refresh</button>
        </div>
      </div>
    `;
  }
}
```

Popup surfaces use a single-column layout, size to their widest item by default, and are constrained to the available space. `AnchoredPopupController` owns their native popover presentation, anchoring, viewport constraints, and open-only layout subscriptions. Consumers provide the anchor, panel, placement options, and close callback; they should not add separate stacking or positioning rules just because the popup lives in a flex or grid container. The panel stays in its existing themed DOM root rather than being moved to the document body.

A popup item uses both `ui-button` and `ui-menu-item` on its native button. A checkbox option uses `ui-menu-item` on its native label, containing its input. Add `danger` for a destructive action. Keep placement, open/close state, and event handling in the owning component or its existing controller.

`ui-menu` describes the surface, not an ARIA role. Do not add `role="menu"` unless the owner implements the corresponding keyboard behavior. The [popup/menu styling contract](theme-styling-contract.md#popups-and-menu-controls) adds `ui-popup-trigger` and `ui-popup-panel` to existing controls, separates native visibility/disabled/checked states from current destinations, and lists supported contexts. Completion lists and message-action strips share popup anatomy without adopting menu layout.

## Surface ownership

Use three distinct models rather than coordinating application-wide `z-index` values:

- **Local decoration** stays with the layout that owns its boundary. `ConversationLayout` owns transcript/composer placement and the activity indicator across their shared border; `ChatView` owns transcript scrolling and content.
- **Anchored popup** uses `AnchoredPopupController` in `components/anchoredPopup.ts`. Native popovers escape ancestor clipping and stacking contexts. Shared positioning handles scrolling across shadow roots, resizing, and visual-viewport changes. Completion panels preserve editor focus and anchor above the editor within the stable application layout, independently of keyboard viewport changes; action panels retain their own keyboard behavior and viewport constraints. Nested popups close from the innermost outward on Escape.
- **Modal dialog** uses `ModalSurface` backed by native `<dialog>.showModal()`. Browser modality makes background content inert. The modal registry coordinates active ownership and safe focus restoration; it does not establish a global CSS stacking scale.

A popup may open only within the active modal's composed subtree, or in the ordinary application when no modal is active. Opening a modal dismisses unrelated popups. Hiding, making inert, or removing an owner closes its popup. Keep popup state in sync through the close callback, including browser light dismissal. Application layout must not inspect a child's menu-open state or raise entire panels to make a popup visible.

Local sticky headers, shadows, and decorations can still use small stacking values inside their owner. They must not determine popup or modal precedence. Native plugin dialogs participate in the same modality boundary without importing private host modules.

## Sidebar list surfaces

`listStyles` provides `.list-status` for muted, padded loading feedback inside a list body. Use `role="status"` for announcements and `aria-busy` on the loading body.

`activityIndicatorStyles` in `src/client/src/theme/base/activityIndicatorStyles.ts` owns the shared activity, intervention, and unread marks used by navigation lists and the machine selector. `listStyles` includes it; the machine selector imports it directly. Consumers own placement and can retain a root-specific work-pulse variant, but the static intervention/unread treatments remain shared. These defaults use `pi-web-base`, so contributed theme rules can override them without `!important`. Indicator internals remain experimental; use the documented navigation state and anatomy hooks for supported theme contributions.

`sidebarListStyles` is the shared treatment for navigation lists. Projects, workspaces, and sessions expose supported context, anatomy, and state hooks through the [navigation-row styling contract](theme-styling-contract.md#sidebar-navigation-rows); those hooks reuse existing containers without changing row behavior. Grey section headers provide hierarchy above dark, continuous rows. Keep rows full-width and gapless; do not introduce inset card surfaces or visual gutters. Selected, hover, and keyboard-focus states remain on the entire row. Collapsed navigation sections keep the heading's 1px separator and omit the outer section border so adjacent borders do not double the line thickness.

## Dialog patterns

Use the existing `ModalSurface` component for native modality, focus placement/restoration, Escape, backdrop dismissal, and dialog naming. The content patterns in `ui/dialogStyles.ts` compose with that surface; they do not add another modal controller or wrapper.

- `uiDialogStyles` provides common header, close button, search row, scrollable body, and footer treatment. It includes `uiButtonStyles`.
- `uiSelectionStyles` provides gapless option rows, composite rows with separate pin/checkbox actions, descriptions, and empty states. Combine it with `uiDialogStyles` for selections such as models, thinking levels, and Actions.
- `uiFormStyles` from `ui/formStyles.ts` provides field labels, native input and textarea styling, checkbox rows, and form errors. It is also re-exported by `ui/dialogStyles.ts`. Combine it with `uiDialogStyles` for provider login, adding machines, and adding projects. Inline question forms and extension dialogs reuse the same fields without importing modal layout. A dialog with both choices and a form can compose all three.

Use `ui-dialog-header`, `ui-dialog-title`, and a native `ui-button ui-button--icon` close button. Search inputs use `ui-dialog-search`; put a search input and adjacent actions in `ui-dialog-search-row`.

Selection lists use `ui-selection-list`; each native choice button uses `ui-button ui-selection-option`. Use `ui-selection-row` when a row has independent actions, and `ui-selection-detail` for its description. Keep existing selected-state classes and keyboard navigation with the consuming component.

Form content uses `ui-dialog-body ui-form-body`. Labels use `ui-form-field`, text inputs use `ui-input`, and checkbox labels use `ui-checkbox-field`. A native form that wraps the complete dialog uses `ui-form`. Its footer uses `ui-dialog-footer`, with native `ui-button` actions and `ui-button--primary` for the submit action. Interior action groups can use `ui-form-actions`. Labels, validation messages, input types, submit behavior, and callbacks remain local.

Keep only content-specific rules in each dialog. Existing dimension differences can use the internal composition properties `--ui-dialog-width`, `--ui-dialog-max-height`, and `--ui-dialog-top`; do not copy the common backdrop or header styles. These primitives use the base theme; selected themes can override their presentation through the existing contributed stylesheet mechanism.

## Settings and configuration groups

`uiSettingsStyles` from `ui/settingsStyles.ts` provides flat configuration sections (`ui-settings-section`), headings (`ui-settings-heading`), field stacks (`ui-settings-fields`), action groups (`ui-settings-actions`), config paths (`ui-settings-path`), effective-value summaries (`ui-settings-summary`), and gapless lists/rows (`ui-settings-list`, `ui-settings-row`). Compose these with `uiButtonStyles` and `uiFormStyles`; they do not introduce new controls or state ownership.

Settings actions use `ui-button--action` to distinguish them from flat navigation and selection rows, including primary actions. Action groups leave an 8px gap between individually bounded controls and stack on narrow screens. This internal modifier is not currently included in the experimental plugin shared-UI bundle.

Sections own their internal padding and a bottom separator. Do not surround them with inset cards or exterior gaps. Paths and effective values can use a neutral background without another outline. Labels stay sentence case. Keep domain-specific layouts, validation, draft state, and save callbacks in the consumer.

`SettingsPanelFrame` composes the section heading, refresh action, notices, and slotted content for settings panels. `uiNoticeStyles` from `ui/noticeStyles.ts` provides `ui-notice` with error, success, warning, and info tones. Consumers retain the appropriate live-region role and message content; styling does not announce a message by itself. These internal patterns are not yet part of the public plugin UI styles capability.

## Transcript hierarchy

Chat uses flat transcript sections rather than nested card outlines. Put breathing room inside the section; use restrained role/state tones and labels to distinguish hierarchy. Successful tools stay neutral, while running and error states remain explicit. Nested sections do not need another enclosing border. Code/diff content may retain one useful boundary, and editable inputs retain their input affordance.

`uiTranscriptStyles` owns the frameless surface and full-width disclosure treatment (32px for every input type). Consumers own grouping, indentation, native disclosure state, and layout. Give sticky headings an opaque tone matching their section so scrolled text cannot show through them. Transcript patterns are internal and are not part of the browser-plugin UI styles capability.

Chat navigation arrows render as one bordered group anchored to the message input's top-right, with a divider between the arrows. The bottom-right attachment button matches an individual arrow's 28px size for every pointer type, and stays anchored as the input grows, without a separate row between transcript and composer. `ChatView` retains scroll ownership and supplies its controls through `onNavigationChange`; `PromptEditor.chatNavigation` renders them with shared `chatNavigationStyles`. The non-interactive activity indicator is 18px tall, centred horizontally and vertically across the chat/composer border, and disappears when idle. `ConversationLayout` positions the indicator over the shared border without adding padding or a separate row; neither the transcript nor composer is raised above the other to accommodate it.

The statistics footer is non-interactive: it extends into the shell's reserved bottom safe area, has a minimum height of 32px or the bottom inset (whichever is larger), and vertically centres its text. The shell continues to reserve its bottom inset for every other surface, keeping interactive controls above it. Persistent session warnings belong to the ordinary Notices panel, not the composer or statistics footer; immediate event notifications remain in the chat notification tray.

Composer control purposes and default-action states have [supported hooks](theme-styling-contract.md#composer-controls) on the existing toolbar groups and native buttons; no extra wrapper is needed. The editor keeps a two-line text minimum even when empty or containing one line. Vertical padding belongs to the editor frame, outside the scroller, so long drafts retain top and bottom clearance at the 220px height cap.

### Activity-group layout contract

Activity groups and their `.group-msg` wrappers have no padding. In `chatTranscriptTemplates.ts`, `renderGroupedParts` assigns each visible part one of two explicit layouts:

- `.transcript-section`: thinking, tool executions, tool-call/result surfaces, and inline question forms/records. Sections fill the available width with no exterior padding or margin. Each surface owns its heading and internal body padding, including when collapsed.
- `.transcript-content`: consecutive ordinary text, skill descriptions/disclosures, and images. A content run owns 8px vertical and 12px horizontal padding. Message headers use the same content inset; adjacent content wrappers do not double their vertical spacing.

For mixed messages, alternate sections and content runs rather than padding the whole message and making sections escape it with negative margins. Empty displayed text does not create a content wrapper. Keep ordinary conversation-message layout separate from this activity-group contract.

```html
<section class="group-msg ui-transcript-surface">
  <div class="transcript-section"><!-- full-width thinking/tool/form surface --></div>
  <div class="transcript-content"><!-- inset ordinary content --></div>
  <div class="transcript-section"><!-- next full-width surface --></div>
</section>
```

The chat consumer owns these layout classes and message separators; `uiTranscriptStyles` owns surface and disclosure styling. New activity parts must choose their layout in `renderGroupedParts`, not add message-type padding exceptions. Verify expanded and collapsed sections, section-to-section boundaries, and mixed content in a real browser.

### Inline forms and records

`uiTranscriptCardStyles` from `ui/transcriptCardStyles.ts` provides sticky header and status treatments for inline question forms and extension dialogs. Use `ui-transcript-card-header` and `ui-transcript-card-status`, with optional success or warning modifiers. Compose disclosure headings with a native `summary.ui-transcript-disclosure`; the disclosure primitive owns its indicator. Consumers retain heading semantics, form state, validation, draft persistence, countdowns, and submission behavior. Inline forms do not acquire modal focus trapping or Escape dismissal.

## Ownership and hierarchy

### Control sizing policy

Keep button and other control dimensions consistent across mouse, touch, and pen input. Do not change their size solely through pointer or hover capability queries such as `(pointer: coarse)`. Touch capability does not determine available screen space.

When responsive sizing is needed, use viewport or container size and preserve usable targets, clear separation, and keyboard-focus feedback at every size.

Also prefer consistent visibility and behavior across input types. Avoid pointer and hover capability queries by default; do not use touch capability as a proxy for screen size or user intent. A hover-specific adaptation can be appropriate when the interaction genuinely depends on hover, but keep the same actions discoverable and reachable without hover, including by keyboard. Use these exceptions sparingly, not as a general desktop/mobile split.

- Primitives own control sizing, padding, borders, hover, focus, selected, disabled, and danger treatments. Change those centrally rather than copying them into each screen.
- Consumers own layout and domain content: labels, counts, tree indentation, popup placement, and callbacks. Preserve semantic classes used by controllers and tests alongside primitive classes.
- Standalone buttons default to 44px targets. Secondary toolbars, popup items, and compact buttons use 32px targets. Small transcript actions use 28px targets with 14px icons, matching the chat corner arrows. Message headers use a single always-visible ellipsis trigger for every input type. Clicking it reveals a single-row icon strip to its left; overflow scrolls horizontally rather than wrapping. `pi-message-actions-menu` owns native popover dismissal and placement; consumers supply accessible icon buttons. Conversation controls overlay the bottom-right corner without reserving a text column or header row. The closed trigger has no background. Expanded controls use an opaque background matching the transcript surface and a subtle inset shadow for contrast; expanded message information follows the message body. Respect reduced-motion preferences when revealing the strip. Control dimensions do not change with pointer type. Compact file/tree rows remain 32px, with matching 16px indentation in Files and Git.
- Toolbars (`.ui-toolbar`) own a 1px bottom separator by default. Use `ui-toolbar--borderless` for embedded control strips or footer toolbars whose containing surface already owns the boundary. Tab strips (`.ui-tabs`) keep their existing consumer-owned boundaries.
- Use shared separators, not repeated outlines or exterior gaps between related controls. A group followed by empty bar space needs a trailing boundary; use `ui-toolbar-group--bounded` rather than a one-off button border. Its separator shares the next group's leading border when the gap collapses. Do not add a trailing separator where the bar edge already bounds the group. Keep meaningful separation between unrelated groups.
- Keep the subsession disclosure as a muted, specialized tree control (24px for every pointer type), not a toolbar button. Its size does not depend on touch capability. Expansion changes the chevron, not the text color; preserve hover and keyboard-focus feedback.
- Check geometry in a real browser. Native-control interaction tests still belong at the consuming component boundary.

## Renderer headers

Chat code blocks and Files expose each matching renderer as a named native button rather than a select menu. Files uses this same strip for document previewers, text-renderer adapters, and other plugin file views. Source files offer Raw; binary files offer their matching previewers without a redundant Original view. Download remains a separate action. Clicking a renderer button both selects and activates that view, including manual renderers. Use `aria-pressed` for selection; these are buttons, not ARIA tabs. Renderer titles supply names, with plugin/contribution IDs as the fallback.

Keep the view buttons on one horizontally scrollable row, using native overflow scrolling like the existing shell headers. Buttons must not shrink or wrap their labels. Keyboard focus and touch scrolling keep off-screen views reachable. Chat keeps Copy outside the scrolling strip; Files keeps Open and Download outside it. Preserve compact control sizing across input types and inset focus indicators.

## Migration boundary

The current consumers are navigation headings, session selection controls, navigation dropdowns, the chat composer's model/thinking/send/stop toolbar, main navigation tabs, the common selection/form dialogs, Settings, chat transcript sections and controls, and session cleanup. Cleanup uses the shared dialog and form chrome with its own rules and project-selection table layout.

The base theme's internal style exports also supply the host-managed [shared UI bundle](plugins.md#host-provided-ui-styles). Plugins request `stylesheet-integration` and opt each root in with `{ sharedUi: true }`; the host injects, orders, and removes shared sheets. Plugins must not deep-import these modules, copy their styling, or insert shared CSS text themselves. Relay, Files, Git, and Tasks use the shared controls. Menus, forms, dialogs, and transcript patterns are not currently included.

Styling remains experimental outside the [initial theme styling contract](theme-styling-contract.md), which supports conversation anatomy, selected-choice hooks, project/workspace/session navigation rows, composer controls, and popup/menu anatomy. The remaining shared classes, theme properties, markup patterns, layout, and appearance may evolve between releases. The integration capability's version describes its methods, not a stable visual design or complete CSS class contract. Keep consumers aligned when changing shared patterns.
