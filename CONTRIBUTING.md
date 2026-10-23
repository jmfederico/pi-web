# Contributing

## Writing for people

AI is expected to do the work, but that does not mean AI is expected to write the issues or responses. Humans are welcome and expected to write whenever they choose.

When AI does the writing, it should write **for humans, not as a human**: help the reader understand the problem or make a decision, without simulating a human author. The guidance below keeps contributions readable regardless of who writes them.

Use plain, direct language. Say what happened, why it matters, and what you need. Prefer a few clear sentences over a report full of headings, checklists, or repeated summaries. Avoid hype, boilerplate, and implementation narration. Short is useful; a word limit is a ceiling, not a target.

The maintainer's editorial preferences are clarity, brevity, and relevant detail—not an instruction to imitate their voice or personality. Agents should not impersonate people or invent human experiences, motivations, or approvals. Attribute work accurately; do not claim a human did work that an agent performed.

Agent publication and attribution requirements are in [AGENTS.md](AGENTS.md#ai-attribution).

Agents are responsible for gathering and maintaining the context they need. Keep that context separate from the human-facing message; do not make people read it to participate. Decisions, risks, and questions that need human attention must stay visible.

## Issue and pull request descriptions

Write for a human reviewer: **what is being reported or proposed, and why does it matter?** The opening must stand alone and be easy to scan without reading code, filtering out implementation details, or asking an agent to translate it. Having a clear what and why somewhere in a long description is not enough.

The end of the opening is a stopping point: a reviewer should be able to stop there and understand the report or proposal. Keep decisions, material risks, and questions requiring human input visible there.

Start with `## What and why` and keep that section to **250 words maximum**. Include the problem or change, who it affects, and why it matters. For bugs, include expected/actual behavior and only the reproduction steps needed to understand the problem. Longer reproduction procedures belong in the appendix. Technical vocabulary and commands are fine when they identify the problem; they are not a reason to include an implementation explanation.

Put implementation walkthroughs, inventories of files or symbols, lengthy logs, investigation notes, detailed verification results, and extra AI context in a second, optional collapsed section. Don't repeat details a reviewer can discover from code in the opening. A brief technical reference that identifies a problem is fine; explaining the implementation is not. Accurate, relevant implementation detail still belongs in the appendix—even when the opening is below the word limit.

```markdown
## What and why

Reconnecting from a phone loses the selected session.
The same session should remain selected so work can continue
without searching for it again.

<details>
<summary>Technical details — optional reading</summary>

Optional logs, investigation, implementation notes, and AI context.

</details>
```

The structure matters more than exact appendix wording. Use a clear summary such as `Technical details — optional reading` or `Technical details and verification`; equivalent wording is welcome. A short attribution after the collapsed section is fine. Do not request a rewrite solely for these cosmetic differences.

The technical appendix has no word limit, but should remain relevant and must not contain secrets. Remove it when unnecessary. Do not hide information essential to deciding whether the report or proposal matters.

### One decision per issue

Each issue should present one independently decidable request. If one proposal could be accepted while another is rejected, put them in separate issues and link them. A shared deployment context or general goal does not make independent proposals one request.

This does not mean one symptom, one file, or one implementation step per issue. Related symptoms and necessary parts of the same outcome can stay together. A focused issue can also have multiple type labels.

When an issue bundles independent requests, identify what should be separated rather than summarizing them into an apparently unified proposal. Use `review: needs-rewrite` when the requests are clear but need splitting, or `review: needs-clarification` when their relationship or intended outcome is unclear. Splitting is an editorial request, not acceptance or rejection of either proposal; agents must not choose which proposal to keep without authorization.

### Description reviews

Maintainers may dispatch agents to review descriptions. **Closure is not enabled.** Reviews are comment-only by default; maintainers can explicitly request labeling or a read-only dry run instead. There is no continuously running gate, required status check, or automatic review on submission.

Agents should review descriptions, not the merits of the contribution. AI judgments can be wrong; contributors can ask a maintainer to review the feedback.

The ongoing review process checks structure and readability, not exact appendix wording, and does not edit submission bodies. A description that lacks the opening `## What and why` section or leaves supplementary technical detail outside the collapsed appendix receives `review: needs-rewrite`; if essential meaning also needs clarification, `review: needs-clarification` takes precedence. Equivalent appendix summaries and a short trailing attribution do not block readiness.

Editorial opinions and requests to split, clarify, or rewrite belong in review comments, not in the submission's body. Labels record the review outcome; they do not replace specific feedback when a review comment is authorized.

### Labels

Readiness and type are independent. After review, use exactly one readiness label:

| Label | Meaning |
| --- | --- |
| `review: ready` | The opening explains what/why and is easy to scan without implementation narration; an issue presents one independently decidable request. |
| `review: needs-clarification` | Essential meaning is missing or ambiguous; a specific answer is needed. |
| `review: needs-rewrite` | The information is available, but the opening needs rewriting, technical detail needs separating, or independent requests need splitting. |

No readiness label means unreviewed. If clarification and rewriting are both needed, use `review: needs-clarification` first. Ready means ready for a human to read—not a confirmed bug, accepted proposal, or merge approval. Labels describe the last review; edits may require reassessment.

Apply every relevant type label, including multiple labels for mixed requests:

| Label | Meaning |
| --- | --- |
| `type: bug` | Reports broken or unexpected behavior. |
| `type: support` | Requests help using, configuring, or understanding the project. |
| `type: feature` | Requests new or changed capabilities. |

Classify the reported concern, not whether it has been verified. Do not infer types solely from the title or force an informational post into an unrelated category.

#### Find unreviewed submissions

No default label is needed. In the repository's GitHub issue or PR search, find open submissions without a readiness label:

```text
is:open -label:"review: ready" -label:"review: needs-clarification" -label:"review: needs-rewrite"
```

Add `is:issue` or `is:pr` to select one kind. This includes submissions that already have type labels. Use `is:open no:label` only to find submissions with no labels at all; it is not the full unreviewed queue. These searches do not detect stale readiness labels after description edits.

Creating an issue does not by itself grant permission to assign labels. Maintainers and collaborators with sufficient repository permissions can apply them; authenticated agents act with the permissions and authorization they are given. The templates do not assign readiness labels.

Maintainers and agents: follow the [description review runbook](docs/github-description-review.md).
