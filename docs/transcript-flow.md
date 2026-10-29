# Bounded transcript flow

Status: staged design. The first-round reuse/cache improvements, source-address/interaction-state foundation, and viewport authority described in [chat behavior](chat-behaviors.md#long-session-work-boundaries) are implemented. A mounting pilot covers ordinary rows, activity children and galleries but is disabled in development and production after a second physical iPhone Safari test still showed repeated jumps. The pilot is parked: measure the full-mounting path and reassess the approach before adding corrective machinery or planning another rollout. Qualified history reads and active eviction remain future milestones. This document is not a claim that active browser history, rendering, or network payloads are already bounded.

## Goal

Updating the latest message should not require processing, mounting, or retaining the entire conversation. A reader looking at old messages must not lose their position, focus, draft, or selection because new output arrives.

Treat these as separate contracts:

- **Persistence:** Pi owns the session file and model context. Browser eviction never deletes Pi history.
- **Synchronization:** one snapshot and its event-stream boundary establish current conversation facts.
- **Residency:** the browser retains a reader neighborhood and a live-tail neighborhood, not every message between them.
- **Presentation:** only the viewport, overscan, and explicitly protected interactions need mounted content.
- **Interaction state:** user choices and pending requests outlive recycled presentation elements.

A fetch page size is not a residency limit. A residency limit is not a mounted-content limit. A collapsed or detached body is not necessarily released.

## Ownership

| Owner | Responsibility | Must not own |
| --- | --- | --- |
| Pi SDK | Durable entries, branch structure, model context | Browser viewport or eviction decisions |
| Daemon transcript reader | Authoritative branch projection, qualified page cursors, anchor lookup, snapshot boundary | Browser scrolling |
| Selected-transcript controller/store | Retained ranges, live overlay, request cancellation, reconciliation and eviction | Element geometry or scroll writes |
| Presentation projection | Stable semantic rows and group membership derived from retained data | Network requests or navigation decisions |
| Viewport controller | Follow/read/navigation intent, mounted window, measurements and scroll adjustment | Authoritative conversation facts |
| Request and UI-intent stores | Active forms, submissions, drafts, disclosure and tool-view choices | Cached DOM or complete historical bodies |
| Components and renderers | Rendering, input events, cancelable enhancement resources | Deciding whether history exists |

`SessionController` remains the transport/session orchestrator. Transcript range and replay logic should move behind a selected-transcript boundary rather than acquiring more unrelated flags there.

`ChatScrollFlows` owns viewport behavior through one scheduled transaction and one commit boundary. Tail-follow tracks navigation intent without scheduling or writing. Earlier-history loading schedules requests independently but cannot move the viewport. Do not introduce another scroll writer beside this boundary.

## Addresses before windows

Presentation identity must be established before filtering or splitting content:

1. Transcript scope includes machine, session, and projection generation.
2. A committed source is addressed by durable entry ID and original content-part identity.
3. A derived row adds its semantic slice: text, thinking, tool execution, question, or another explicit type.
4. Tool executions use `toolCallId` where available. An original source-part address distinguishes multiple executions in one entry.
5. Provisional content has a transient stream/optimistic address. Finalization aliases that owner to its committed address without replacing a mounted element.

Normalized indexes, projected part indexes, raw offsets, and current group edges are not durable addresses. Group membership and live/historical styling are presentation properties, not reasons to rename a surviving row.

Normalization now carries original `content:N` provenance through filtering and coalescing; tool calls use their semantic call IDs. Optional indexed text/thinking deltas preserve the same part key as saved history. Tab-owned, bounded identifier aliases join stream and entry owners without retaining transcript bodies. Disclosures use the committed key after finalization; remote-machine disclosure storage is isolated while existing local storage remains readable. Repeated ask answers retain distinct entry identities.

The current `ChatRenderKeys` reconciler preserves mounted owners across adjacent updates; it is not a durable address book for evicted content. Legacy unindexed streams/manual lines retain local-slot fallback behavior, not a fabricated original-part identity. Projection generations remain part of the qualified-read milestone. Scroll bookmarks now use machine/session scope: local keys remain compatible, while remote keys are separate. Legacy remote bookmarks were not machine-qualified, so migrating them could adopt another machine's position; remote sessions deliberately start without those ambiguous bookmarks.

## One viewport transaction

The viewport has one of three intents:

- **Following:** align the logical latest content, including permitted form alignment.
- **Reading:** preserve a visible semantic anchor and its viewport-relative offset.
- **Navigating:** resolve an explicit destination, then become following or reading.

For a content, disclosure, range, or layout change:

1. Capture the current intent and usable leaf anchor.
2. Apply the data/presentation change and select the mounted window.
3. Render.
4. Measure changed rows.
5. Make one coalesced scroll adjustment, then record its baseline.

The implemented transaction chooses one pending target per coalesced commit: remembered restoration, otherwise the original pre-prepend anchor, otherwise coalesced tail/form alignment. Consecutive renders retain the first prepend snapshot until commit. Explicit top/end navigation retires queued targets and commits synchronously through the same boundary. Native user interaction retires obsolete restoration/prepend work; programmatic corrections record a fresh follow baseline. Persistence timers and history requests do not own scroll writes.

For the windowing pilot, the render boundary joins mounted Lit elements and their shadow descendants before the viewport owner commits geometry. This includes descendants created by a parent's queued render, without waiting arbitrary extra frames or for network/image/preview completion. A window change triggered inside an animation frame must not paint its changed spacers and defer compensation to the next frame. The shared viewport also carries fractional-pixel rounding precision through native movement and changes of reader anchor; range clamping is not treated as rounding. Already-aligned anchors do not assign `scrollTop` again, because even a no-op assignment can interrupt a native gesture.

Formatting, image geometry and previews already notify this owner. Complete measured-row/window integration remains gated by the pilot checkpoint below; paused reading views retain the existing layout behavior outside explicit prepend/restoration correction. Window shifts must enter this transaction too. A resize observer reports geometry; it does not decide navigation. User input cancels obsolete restoration. Programmatic adjustment must not be mistaken for an upward reading gesture. Keep Safari rebound normalization and the explicit native-anchoring policy.

Anchor resolution must distinguish:

- retained but not mounted: mount it;
- evicted but reloadable: fetch around its durable address;
- hidden by disclosure: resolve to the owning summary unless navigation explicitly expands it;
- outside the current generation: invalidate the old restoration;
- genuinely absent: stop visibly, without jumping to an unrelated message.

The current fallback of repeatedly fetching older pages until an anchor appears in the DOM is not sufficient once pages can be evicted.

## Presentation units and lifetime

Use stable, variable-height presentation rows. Turns are semantic boundaries, not indivisible virtualization units.

- A collapsed activity group is a summary row.
- An expanded group has independently windowable child rows.
- Galleries must not make an unlimited collection one indivisible item.
- A very large message/body needs a separate payload/presentation policy; mounting one item can still be expensive.

### Mounting pilot checkpoint

The internal `mountingWindow` capability remains disabled in the shared/production defaults. The development application opt-in was withdrawn again after the physical-device retest still showed repeated jumps. Refreshing a development browser restores the full-mounting path without restarting sessiond. Standalone components and fixtures retain their explicitly injected behavior. When explicitly injected, `transcriptMountPlan` partitions retained rows into nearby mounted ranges, protected islands and aggregated height spacers. `TranscriptMountWindow` measures mounted roots with a resize observer, invalidates measurements by source revision and width, and releases metadata when its retained key disappears or the transcript scope changes. It owns neither authoritative history nor scroll position. Mounting invalidation captures the reader through the existing viewport owner; pending corrections keep their addressed row mounted until commit or cancellation. Native movement after capture retires an obsolete mounting correction, while an exact browser clamp to a shorter range remains a layout correction. Successive corrections preserve the logical reading offset rather than accumulating browser pixel rounding. Restoration first mounts a retained address rather than misclassifying it as missing history.

Ordinary rows, collapsed summaries and compound owners participate in the outer window. Expanded activities use independently windowable child rows; galleries use visual thumbnail bands and independently windowed source rows. `TranscriptMountLists` owns only child-controller lifetimes, using the same global scroller and viewport correction boundary. Closing or unmounting a pilot body disposes its observers, measurements and DOM rather than retaining a detached cache. Explicit tool/disclosure intent remains outside recycled elements.

Thumbnail dimensions are shared by presentation and band planning. Bands provide vertical geometry; individual image keys preserve native cell identity when columns change, and callbacks keep original full-gallery indices. Retained children of a closed activity resolve to the visible summary without opening the activity or paging past already-retained data.

Active ask forms stay mounted. The pilot protects focus, composition and popup owners; native selections with content and active modal layers conservatively protect all currently mounted roots because cross-shadow selection and return-focus ownership can be opaque. Selection protection is sampled on selection changes, including WebKit selections whose public endpoints appear collapsed. Protection can exceed the ordinary neighborhood; there is no unconditional mounted-row or memory ceiling. Browser fixtures verify variable-height ordinary rows, giant expanded activities, tool intent across child recycling, gallery geometry/indexing, retained open/closed-child restoration, and selection/focus/draft preservation. Live testing exposed repeated micro-jumps despite the settled-position checks passing. Add continuous frame sampling during idle reading, scrolling and live updates; a correct eventual position does not establish visible stability. After-paint slow-scroll probes reproduced an intermediate-frame fault: measurement-driven mounting renders could paint before next-frame compensation. The mounted-render boundary addresses that fault in the isolated probe, but the subsequent iPhone 14 / Safari / iOS 26 retest still showed repeated jumps while scrolling. The isolated fix did not establish a usable physical-device result. Both live paths keep windowing off; do not treat additional compensation layers or another rollout as the default next step.

Before enabling production chat, tighten selection islands where reliable and complete width-change, popup/composition and geometry/navigation acceptance checks through the same transaction, including the affected-iPad check and large-session measurements. Keep current retention and the public rendering templates; do not create a second transcript store or scroll authority.

For the complete mounting milestone, retain the existing loaded data and use estimated/measured spacers for unmounted rows. This isolates mounting changes from network/replay changes. It bounds ordinary mounted history, not total browser memory. A whole-group prototype must not be reported as bounded rendering while expanded groups remain unlimited.

Keep height metadata only for retained rows, keyed by address and invalidated by content, width/layout, and disclosure revisions. Once data eviction exists, do not retain a full-session height/identity index solely to offer an apparently proportional scrollbar. The historical reader has a local scroll range; missing intervals are navigation/load boundaries, not enormous fabricated spacers.

Offscreen DOM is disposable. Explicit disclosure, tool-view, renderer/Raw and draft intent is separate, compact, and budgeted. Cancel effectful previews on unmount; reapply eligible intent on remount. Image dimensions never authorize loading an image.

Focused rows, selection-intersecting rows, composition targets, and popup owners are protected from automatic unmounting. Protect those islands, not every intervening row. Strict memory ceilings cannot coexist with arbitrary cross-history native selection: define an explicit selection-boundary policy before enabling eviction that could remove a selected range. Never silently destroy selection or typed input to meet a budget.

Active ask/extension requests and in-flight submission state have request-scoped ownership outside recycled history. Render one active form, not a second copy in another window. Historical question records remain history; eviction of a closing record must never reopen a question. Determine active-request facts from authoritative conversation state, not the mounted or retained historical tail. Current placement is unchanged. `PiWebApp` now owns the injected `PendingFormState`: ask buffers are memory-first with the existing best-effort draft persistence, extension inputs are memory-only, and concurrent sends share a synchronous operation lock. Only an accepted controller response clears ask memory; authoritative dialog snapshots/closures remove extension buffers. Startup handoff moves the existing request owner before selection replacement. Component removal does not cancel transport or clear its draft. Idle request buffers are LRU-bounded; mounted active forms and pending operations stay pinned until unbinding or settlement. This is tab-instance protection, not reload/cross-tab deduplication.

`TranscriptUiState` separately holds bounded tool disclosure/full-diff intent. Copy feedback, countdown timers and sensitive closed-answer reveal remain local to their component lifetime. The complete mounting milestone must preserve these protections and keep one active form mounted; production recycling remains disabled.

## Data residency and synchronization

The reader and live tail are two regions of one document, not two independently authoritative transcripts. Overlapping retained pages share data. While reading old history:

- live events update the live region and request/status state;
- the reader's anchor and pages remain undisturbed;
- offscreen live content need not mount or format;
- the intervening history need not be fetched or retained;
- returning to the end loads/resolves the latest region directly.

The store accounts for raw payloads, normalized views, and derived strong references, not just raw JSON. Eviction releases their associated groups, keys, action-header sets, cached templates, detached bodies, measurements and enhancement resources. A row-count cap alone cannot establish a memory budget.

Do not implement this by slicing `ChatView.messages`. Normalization joins tool calls and results across raw entries, and raw offsets differ from normalized-line positions. The current earlier-page path also replaces selected normalized state from the raw cache without preserving all concurrent live progress. Range loading must instead integrate through the same history/live reconciliation owner.

### Required read contract

Keep three distinct identities:

- **Stream epoch and sequence:** qualify event ordering by daemon/event-stream lifetime. A sequence number alone cannot identify a restart.
- **Transcript generation:** identifies an append-compatible lineage. Branch replacement, truncation, or changed addressed content invalidates old cursors. Ordinary append does not. Idle writes from other Pi processes participate in continuity checks.
- **Captured head/revision:** identifies the committed history and total observed by one read. Response arrival order does not determine which head is newest.

A cursor can initially encode a generation-qualified raw offset. Pages need an explicit raw range, captured head/total, earlier/later cursors, and normalization-boundary context. Also support loading around a durable entry address. Reject incompatible cursors rather than silently clamping them into another branch.

Preserve the existing snapshot join rule: subscribe and buffer, install one coherent snapshot, then replay applicable later events from that stream epoch. Earlier/later page reads neither move the stream watermark nor replace the live overlay. Selection/generation changes retire outstanding reads.

The current snapshot partial describes an assistant stream, not every provisional tool/shell interaction. Do not claim complete recovery of those interactions without specifying their checkpoint or reconstruction source.

Older/federated daemons retain the current behavior until the new read contract is available. Strong bounded-retention guarantees must be capability-qualified; do not infer them from the presence of a message-count parameter.

### Oversized content

Current turn-boundary expansion can return more than the requested page limit. Keeping the current turn or newest page whole is therefore not a hard bound.

Hard byte limits require continuation-safe envelopes and a retrievable body boundary. Large content should have bounded inline presentation with explicit full-source/copy/download behavior. Do not slice arbitrary Markdown strings at byte offsets: fences, lists, tables, and plugin blocks can cross them. A capped visual preview backed by an unlimited source string still does not bound memory.

Specify in-flight large-content retrieval and explicit large-content operations separately. Until those exist, document the remaining oversized-turn/body exception instead of silently dropping content or claiming an unconditional ceiling.

## Delivery sequence and stop conditions

1. **Address and lifetime foundation:** preserve source-part provenance, transient-to-committed aliases, machine scope, and request/UI intent independent of mounting. Keep the existing visual presentation.
2. **Viewport authority:** consolidate follow, reading, restoration, prepend and form alignment into one transaction while still rendering everything. Preserve behavior before adding recycling.
3. **Mounted window:** window ordinary rows, collapsed summaries and expanded activity children. Keep retained history unchanged. Report this as a rendering milestone, not bounded memory.
4. **Reloadable-history contract:** introduce qualified reads and around-entry resolution across daemon routes, proxy/federation, parsers, and the selected-transcript controller. Prove page reads cannot erase live progress.
5. **Active retention:** bound reader/tail residency independently and release all derived owners. Introduce explicit missing-range navigation and preserve top-of-loaded-reader versus latest-end semantics.
6. **Close byte-budget exceptions:** continuation-safe oversized content and byte-accounted formatting/intent caches. Only then claim hard payload/residency bounds, with explicit allowances for active user operations.

These are separate checkpoints, not simultaneous implementations of competing transcript paths. Do not ship eviction before reloadability and interaction lifetimes are established. Daemon/protocol changes require a manual session-daemon restart when safe.

## Acceptance boundaries

Follow [testing policy](testing.md); choose contracts rather than incidental markup or exact timings.

- **Addressing:** multiple tools in one entry, split thinking/text, prepend, finalization, eviction/reload, and identical session IDs on different machines preserve the intended owner without aliasing another source.
- **Viewport transitions:** streaming while reading, variable-height rows, disclosure/preview changes, width changes and prepends produce one intended correction. User input retires stale navigation.
- **Interaction lifetime:** recycling preserves explicit tool/preview intent, drafts and submission state. Focus, selection, IME and popup owners are not silently removed.
- **Reconciliation:** older-page responses during streaming, out-of-order reads, branch replacement, daemon restart and missed events cannot overwrite the live tail or certify stale data as current.
- **Budgets:** many small messages, one enormous activity group, one large body and sustained offscreen streaming exercise distinct limits. Detached DOM and derived caches count as retention.
- **Browser composition:** real browsers verify geometry, focus and selection across shadow roots; DOM tests alone cannot prove these. Keep the affected-iPad acceptance check from [chat behavior](chat-behaviors.md).

Local tests establish contracts, not resolution of issue #369. Measure the reported workload only after these flows are coherent, and distinguish rendering, retained-memory, transport, and daemon costs in the result.
