# Composing chat behavior

Normal chat follows progress at the tail, remembers reading positions, loads earlier messages near the top, and offers explicit top/end navigation. Images use native `loading="lazy"` and `decoding="async"`. Markdown code blocks preserve long lines with native horizontal scrolling. Ordinary and renderer-backed blocks share a bordered frame with a normal-flow header outside the scrolling body. The header shows the selected renderer label/chooser when eligible, otherwise the fence language if provided. The Copy icon always copies source, including while a preview is visible. Built-in Mermaid remains click-to-render. Inline code, other Markdown, tool-output views, and Files previews are unchanged.

## Ownership

- When `codeBlocks.previews` is enabled, `PluginRegistry` owns renderer eligibility and a cached chat rendering view per machine. Its identity changes only when the eligible renderer set changes. `PiWebApp` passes that view through `ChatView` to `FormattedText` as an ordinary reactive input, so late plugin loading reveals diagram controls without navigation or transcript remounting. Initial loading and later updates use the same flow; Mermaid previews remain manually activated.
- `ChatView` renders the transcript, tool actions, forms, and native disclosures. It captures native transcript disclosure toggles and reports layout changes to `ChatScrollFlows`, independently of remembering disclosure choices. Closed groups defer their bodies until first opened, then retain detached body DOM for reuse on reopening. Effectful plugin renderers suspend their work while an ancestor disclosure is closed.
- `ChatScrollFlows` owns one viewport transaction for position restoration, prepend compensation, tail-follow and form alignment. These share one coalesced commit and one scroll-write boundary; canceling a capability removes its intent without discarding other queued work. The full-mounting path uses its existing frame scheduler; the windowing pilot joins mounted Lit renders and corrects geometry before paint, rather than exposing changed spacers until the next frame. Earlier-history loading has a separate scheduler but never writes scroll position.
- `transcriptMountPlan` chooses row islands and height spacers without DOM or effects. The internal `TranscriptMountWindow` pilot owns retained-row measurements and mounting invalidation, not history or scroll writes. `TranscriptMountLists` applies the same planner to activity children, gallery bands and image-source rows, disposing child measurements/observers when their list closes or unmounts. It reports corrections through `ChatScrollFlows`. Development and production keep it disabled. The second physical iPhone Safari test still showed repeated jumps after the isolated frame-gap fix. The pilot is parked pending measurement and an architectural reassessment, not another automatic rollout.
- `chatBehaviors.ts` declares the capabilities injected through `PiWebApp.chatBehaviors` → `ChatView.behaviors`. Scroll, image, disclosure, and visual-effects capabilities are enabled by default. Its `codeBlocks` policy enables code presentation, horizontal overflow, normal-flow copy controls, and plugin previews independently; `PLAIN_CODE_BLOCK_POLICY` in `formatting/codeBlockPolicy.ts` remains the known-good rollback baseline. This is an internal composition seam, not user-editable configuration or a diagnostic UI.
- `formatting/markdown.ts` owns sanitized block markup and optional copy controls together. The frame's header and Copy icon occupy normal flow before the source, without absolute positioning, stacking levels, or reserved source padding. `components/codeBlockFrameStyles.ts` shares only frame/header presentation with renderer-backed blocks; ordinary code does not acquire a renderer lifecycle. The literal, copy-free baseline remains unframed. `FormattedText` applies wrap/scroll presentation and delegates clipboard clicks; it never scans or reparents code blocks after rendering. Preview inspection is a separate optional adapter. It uses the same granular update path whether or not a renderer matches, preserving unchanged source blocks and preview hosts as trailing prose streams. A matched preview replaces the entire source block, and its Raw view inherits the same source presentation, overflow, and copy policy. `ContentRendererHost` retains ownership of preview activation, failure, cancellation, and disclosure suspension. The public plugin capability and Files defaults are unchanged.
- Native images own fetching/decoding. Attachment and tool-image references include display-oriented dimensions when their headers are readable, reserving their responsive footprint before position restoration without image-load scroll corrections. Older machines and unreadable headers retain native intrinsic sizing.
- Filesystem and external HTTP(S) Markdown images reuse browser-learned dimensions from one localStorage cache of up to 128 resolved image URLs, with no TTL. Successful native loads refresh the hints; changed images may still shift layout, while unseen images and unavailable storage retain native sizing. External images remain ordinary lazy-loaded native images with their existing links. Hints reserve responsive space before position restoration without additional requests or image-load scroll corrections. Outside-workspace Markdown images retain separate, transient approval: persisted dimensions never authorize loading, and sources remain unset until approved, whether visible or hidden.

In normal chat, scrolling does not update reactive position/index state; only a change of live-follow mode updates its indicator. Earlier-history loading uses a near-top threshold and an in-flight guard. Position memory and prepend preservation share durable session-entry anchors and viewport-relative pixel offsets. They prefer a visible anchor; otherwise they select the nearest usable offscreen anchor to the viewport top, resolving equal distances in DOM order. Transient messages and synthetic cards are not scroll anchors. With no usable durable anchor, no anchor position is saved or restored.

Returning to a saved anchor loads earlier history as needed. If complete history no longer contains that rendered anchor, restoration ends without moving the viewport. Prepending captures an anchor before rendering and restores its offset once after child rendering; consecutive prepends before that correction retain the original snapshot. It does not use total-height differences or compensate for later image loads. Wheel, touch, pointer interaction and transcript navigation keys cancel pending restoration and prepend correction. Editor/control keys retain their own behavior; these adapters do not prevent native navigation. Remembered bottom positions, initial tail-following, and manual top/end arrows remain separate from anchor restoration. Explicit navigation clears obsolete viewport work and commits immediately. Saved positions are machine/session-scoped: local bookmarks keep their existing keys, while remote machines start a separate namespace rather than adopting ambiguous legacy bookmarks.

## Long-session work boundaries

Pi owns durable session history and model context. PI WEB projects that history into browser pages; live events update a separate normalized selected transcript, and HTTP snapshots reconcile committed history. Compaction of model context is not a browser-history retention limit.

`ChatGroupProjection` belongs to one `ChatView`. It reuses slices of immutable source messages and regroups the affected suffix during streaming. Unchanged display groups retain their identity, and guarded templates skip their content until a presentation input changes. Activity-group ownership follows surviving members across prepends; nested entries have their own keys. Localization, disclosure choices, question state, plugin policy and action feedback still invalidate the relevant presentation. Comparing input arrays, determining action-header ownership and reconciling keys can still traverse loaded history.

`ChatTranscriptStore` keeps recently used raw pages within eight sessions and an estimated 16 MiB budget. The most recently used page remains whole even if it alone exceeds that budget, so cache eviction cannot trim the reader's loaded range. Normalized views are memoized by immutable raw-page identity. Browser session storage is only a reload cache: each entry holds at most 100 recent raw messages within a 256 KiB UTF-16 payload budget, and at most eight entries are retained. Oversized newest messages are not persisted. Missing pages are fetched normally.

The daemon caches SDK token/cost/context statistics by committed entry count, branch leaf, session identity and model limits. Volatile activity and queue state remain live. SDKs without a constant-time entry-count API retain uncached reads for compatibility; SDK-provided context usage avoids a duplicate computation.

Production chat still mounts all loaded transcript content. An internal mounting pilot windows ordinary rows, collapsed summaries and compound owners with measured/estimated spacers while retaining all source messages. Expanded activities independently window their children; galleries window visual thumbnail bands and source rows while keeping original image indices and flex wrapping. Both live paths leave it disabled after repeated physical iOS scrolling failures. Before adding more corrective machinery, measure the full-mounting path and reassess whether this approach is justified. Loaded history and previously opened cached bodies can still grow during a long visit; these optimizations do not establish a fixed browser memory or layout bound. The [bounded transcript design](transcript-flow.md) distinguishes the implemented identity/lifetime and viewport foundation from future mounting and retention milestones.

## Following live

The highlighted ↓ arrow means new transcript content follows automatically, whether or not the session is currently streaming. Its tooltip and accessible description report the same mode.

- Press ↓ to jump to the latest content and enable following. Pressing it again keeps following enabled.
- Scroll down to the actual bottom to resume following, allowing less than two pixels for rounding rather than a near-bottom zone.
- Upward wheel/touch input, transcript navigation keys, native upward scrolling away from the bottom, or ↑ pauses following. A stationary scroll event does not undo that choice.
- Content growth and viewport changes retain the selected mode. Native overscroll is clamped for direction detection, so a bottom rebound does not count as reading history.
- Expanding or collapsing a transcript disclosure catches up to the new bottom in one coalesced scroll frame while following. Paused reading views are left alone.
- Restoring a historical reading position, or aligning an open form away from the bottom, pauses following; the arrow shows that pause too.

When the `followTail` capability is disabled, ↓ remains a jump-only control and is not highlighted. This behavior adds no image-load corrections, continuous polling, or layout-settling loop; other late descendant layout changes remain browser-owned.

## Incremental changes

To enable or disable a capability for a requested change, edit its value in `DEFAULT_CHAT_BEHAVIORS`, or inject an explicit `ChatBehaviors` value at the component boundary. Keep the effect inside its owner rather than adding ambient storage, URL switches, or alternate transcript implementations.

| Capability | Owner's responsibility |
| --- | --- |
| `rememberPosition` | Save and restore per-session reading positions |
| `followTail` | Follow new content while live-follow mode is selected |
| `automaticHistory` | Request earlier history near the top |
| `anchorPrepends` | Make one adjustment after earlier messages are inserted |
| `loadImages` | Assign authorized native chat image sources |
| `codeBlocks.presentation` | `plain` keeps literal text; `code` uses native code markup and styling |
| `codeBlocks.overflow` | `wrap` stays in normal flow; `scroll` gives source text a horizontal scroll region |
| `codeBlocks.copy` | Include clipboard controls independently of presentation or previews |
| `codeBlocks.previews` | Allow plugin fence inspection and eligible previews independently of source presentation |
| `rememberDisclosures` | Retain open/closed group choices |
| `visualEffects` | Apply chat sticky headers and decorative effects |
| `mountingWindow` | Internal outer/child mounting pilot; disabled by default, without active-history eviction |

### Code-block restoration results

The current chat policy is:

```ts
codeBlocks: {
  presentation: "code",
  overflow: "scroll",
  copy: true,
  previews: true,
}
```

The plain-text baseline, contained refactor, and wrapped-code presentation were confirmed stall-free on the affected iPad. Enabling the overlay copy-control variant brought the stalls back before any Copy click. Disabling it restored smooth scrolling again. This implicates the presence or presentation of the controls; a clipboard action is not required to trigger the symptom. It does not establish which individual markup or CSS change caused it.

The same copy action with a normal-flow control above the source was confirmed smooth on the affected iPad, both before and after copying. This variant has no positioned wrapper, absolute button, stacking level, or reserved source padding. Keep that presentation; the result points to the previous overlay variant rather than copying itself, without identifying a single CSS rule.

Native horizontal code scrolling was then confirmed smooth on the affected iPad, including vertical chat scrolling after sideways code scrolling. Finally, plugin inspection was restored with horizontal scrolling and normal-flow Copy unchanged. The original affected message remained smooth after reloading. Its ordinary plain-text fences have no eligible renderer and then showed only their Copy icon, not Render/Raw controls. The subsequent shared-frame enhancement adds a fence-language label when present and moves the normal-flow header inside the border. After reloading, the user confirmed that the original affected message remained smooth on the iPad, including after horizontal code scrolling and Copy.

An eligible built-in Mermaid preview was separately verified through Render → Raw in Chromium, including cancellation and copied source text with a stubbed clipboard. The user also confirmed smooth Mermaid Render → Raw on the affected iPad, with Copy copying source while the diagram was visible. Built-in Mermaid remains manual; contributions explicitly declaring automatic rendering retain that policy. Set `previews: false` to disable preview inspection while retaining the current code-and-Copy presentation. Source overflow policy does not constrain a plugin's rendered graphics.

Keep the affected iPad message as the acceptance check between steps; DOM tests and desktop browser measurements do not establish whether Safari's scrolling stall has returned. For rollback, set `DEFAULT_CHAT_BEHAVIORS.codeBlocks` to `PLAIN_CODE_BLOCK_POLICY`. No URL switches, ambient storage, observers, or gesture handlers are needed for these controls.

Implement and verify one UX enhancement at a time. Preserve the cancellation, authorization, and native-DOM contracts covered by the flow/component tests. For verification conventions, see [development checks](development-checks.md).
