# Transcript flow and ownership

PI WEB loads session history in pages and renders the loaded messages. Earlier messages stay available through normal pagination. Scrolling does not remove rows, insert estimated spacers, or evict loaded history.

A large session file, a large loaded page, and a large mounted transcript are different workloads. Establish which one is costly before changing its implementation.

## Owners

| Owner | Responsibility |
| --- | --- |
| Pi SDK and session daemon | Durable entries, branch structure, model context, history reads, and live events |
| `SessionController` | Session selection, transport, snapshot/event joining, and earlier-page requests |
| `ChatTranscriptStore` | Cached raw pages and their normalized views; raw history stays separate from live display updates |
| Grouping functions | Readable/activity slices and adjoining image groups derived from loaded messages |
| `ChatView` and `ChatRenderKeys` | Mounted message/group identity, native disclosures, and message actions |
| `ChatScrollFlows` | Restoration, prepend compensation, tail-follow, and form alignment through one scroll-write boundary |
| `PendingFormState` | Request-owned drafts and in-flight submissions, independent of the currently selected card |
| Components and renderers | Local presentation choices and cancelable enhancement resources |

## History and live updates

Selection uses cached history when available, then reconciles with an authoritative snapshot and buffered events. Earlier-page requests merge raw history; normalization produces display messages. Raw entry offsets and normalized message indexes are not interchangeable: tool calls/results can coalesce, while one entry can produce multiple presentation slices.

The store reuses the normalized view of an unchanged raw page. It has no additional byte accounting, session-count eviction, or persisted-suffix policy. The existing browser reload cache remains best-effort session storage, not authoritative history.

The current earlier-page path can replace selected normalized state without preserving every concurrent live update. Any change to that path needs a reconciliation regression; adding eviction or a second live-tail store would not repair its ownership by itself.

## Presentation identity

Normalization records original content-part provenance before filtering or splitting. A committed part uses its entry and original part identity; tools and questions use their semantic IDs where available. Successive answers to the same question remain distinct history records.

Mounted groups keep their owner when surviving members move during a prepend. Nested activity entries also have keys. Live messages use their stream identity and gain a durable address on commit; explicit thinking disclosure choices transfer to that address. Legacy/manual lines use local slots when source provenance is unavailable.

`ChatRenderKeys` reconciles adjacent renders, not an independent historical alias registry. Tool disclosure and full-diff choices stay with their mounted component. Machine/session scope prevents another machine's identically named session from adopting local disclosure choices.

## Viewport flow

`ChatScrollFlows` selects one pending target: remembered restoration, otherwise the original pre-prepend anchor, otherwise tail/form alignment. Consecutive prepends keep the first anchor until correction. Explicit top/end navigation commits immediately through the same owner. Native interaction retires obsolete restoration and prepend work.

History loading schedules requests but never writes the scroll position. Formatting and disclosure changes notify the existing viewport owner. There is no measurement/windowing controller or second scroll-correction path. See [chat behavior](chat-behaviors.md) for following, restoration, and capability details.

## Request lifetime

Pending requests own their drafts and synchronous submission locks. Navigating away from a card does not cancel its transport operation or erase its draft. Accepted ask responses clear ask drafts; authoritative dialog snapshots and closures release extension input. Failed submissions leave input available for retry.

Ask drafts retain existing best-effort persistence; extension input stays in memory. Startup selection handoff keeps the same request owner. Partial-submit confirmation, copy feedback, countdowns, and sensitive closed-answer reveal remain component-local. There is no generic idle-form LRU or tool-intent cache.

## Performance evidence

For a large-session investigation, open the file through normal paging and begin at the latest messages. Record file size, raw entries fetched, normalized messages, mounted content, and the work performed during loading, typing, and streaming separately. Do not preload the entire file to manufacture a rendering bottleneck.

The daemon reuses token/cost/context statistics while committed history and model limits are unchanged because live events and heartbeats otherwise repeat the same SDK aggregation. Volatile activity remains live. This source-level repeated-work fix is not evidence that mounted messages are the bottleneck.

The removed windowing trials produced jumps on a physical iPhone 14 running Safari on iOS 26 despite passing controlled browser tests. Ordinary paged rendering is the baseline. Tests establish specific contracts, not resolution of issue #369 or physical-device scrolling quality. Follow [testing policy](testing.md) and [development checks](development-checks.md); measure before adding another optimization.
