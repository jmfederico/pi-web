# Transcript flow and ownership

PI WEB loads session history in pages and renders the loaded messages. Pagination and the normal presentation remain unchanged. These boundaries describe ownership, not a claim that large-session performance is fixed.

## History, sources, and mounted elements

- The Pi SDK and daemon own durable entries, branch structure, model context, and live events.
- `SessionController` owns selection, transport, snapshot/event joining, and earlier-page requests.
- `ChatTranscriptStore` owns cached raw pages. Normalization produces display messages; live display updates do not mutate the raw reload cache.
- Grouping projects readable slices, activity, and adjoining image outputs from loaded messages.
- `ChatView` owns presentation and local choices. `ChatRenderKeys` reconciles the currently mounted elements across adjacent renders.

Raw entry offsets, normalized message indexes, and projected part indexes have different meanings. Normalization records original part provenance before filtering or splitting so distinct source content keeps distinct addresses. Groups retain their source message indexes for actions.

Source addresses identify content; render keys identify mounted owners. Committed content uses entry/part or semantic tool/question IDs. Uncommitted rows use provisional slots, and renderer intent can use an existing stream ID. There is no historical alias registry or disclosure-migration pass. Mounted activity owners retain their current choices when earlier members join the group; persistence uses the source address available when the user makes a choice.

Tool choices, confirmation, countdowns, copy feedback, and sensitive closed-answer reveal stay local to their component. Persisted disclosure choices and scroll bookmarks are machine/session-scoped; existing local storage keys remain readable.

## One viewport owner

`ChatScrollFlows` coordinates restoration, prepend compensation, tail-follow, and form alignment through one scheduled scroll-write boundary.

Its pending target has explicit precedence: remembered restoration, otherwise the original pre-prepend anchor, otherwise tail/form alignment. Consecutive prepends retain the first anchor until correction. Explicit top/end navigation commits immediately through the same owner. Native interaction retires obsolete restoration and prepend work.

History loading schedules requests but never moves the viewport. Formatting and disclosure changes notify the existing viewport owner. See [chat behavior](chat-behaviors.md) for following, restoration, and capability details.

## Request-owned form state

`SessionController` owns a `PendingFormState` shared with the rendered cards. It coordinates request lifecycle changes; the form-state owner holds drafts and submission locks. Cards render and edit that state without deciding when the request has ended.

Navigation does not cancel an in-flight submission or erase an open request's draft. Callbacks retain their originating machine/session; a retired card cannot submit against a different selection. Accepted ask responses clear the draft in one place. Authoritative dialog responses, snapshots, and failed startup cleanup retire the corresponding input. Startup selection handoff keeps the same request owner.

Ask drafts retain existing best-effort storage; extension input stays in memory. A shared promise excludes concurrent sends for one request and remains owned until settlement, independently of card lifetime. Confirmation and other display-only choices remain local. There is no idle-form LRU or tool-intent cache.

## Change boundaries

Keep pagination, request lifecycle, mounted identity, and viewport behavior separate. Do not add rendering or retention machinery because a session file is large. Confirm the affected version and reproduce current behavior before proposing a performance change.

Use [testing policy](testing.md) and [development checks](development-checks.md). Source/owner logic belongs in focused tests; browser composition checks cover scrolling and focus. Passing controlled browser tests does not establish physical-device scrolling quality.
