---
name: relay-runner
description: "Opinionated full-lifecycle software-delivery profile for Relay chains in Git repositories. Load when preparing or running every leg of a Relay created by /relay or /relay-worktree, whenever a preparation or handoff prompt names relay-runner, or when an active Relay operations record declares this profile. Governs scope, adaptive leg sizing, checkpoints, verification, commits, review/remediation, delivery, and handoff. Do not load for generic Relay questions or Relays that declare another operational profile."
---

# Relay runner

Use this skill as the opinionated software-delivery profile layered on the project-neutral `relay` method. It assumes a Git repository and optimizes for small, durable, independently reviewable progress from initial dispatch through delivery.

This profile binds the base `relay` method's tool-agnostic principle, durable-state roles, context containment, and invariants to Pi's session tools and an opinionated Git/software-delivery workflow. Dispatch and handoff prompts are responsible for selecting both skills before a runner begins; skill bodies do not bootstrap other skills.

## Profile contract

For a Relay using this profile:

- Have the preparation prompt select `relay-runner` before drafting the packet. Record it immediately in draft `operations.md` and retain it as required for every active leg, including implementation, review, remediation, and delivery.
- Name both `relay` and `relay-runner` in every handoff prompt. Fresh sessions cannot inherit a prior runner's loaded skills.
- Treat the charter as destination and scope edges, `operations.md` as this profile's repository and execution bindings, `status.md` as current position and next work, and repository instructions as the quality and implementation authority.
- Follow canonical repository policy when it conflicts with a profile default. Record a material operational adaptation in `operations.md`, not the charter. Stop for human intervention when reconciling the conflict would change the finish line or an edge, weaken a protected invariant, or require a product or business decision.

This profile is intentionally strong. A project that wants another way of working should use the base `relay` skill with a different profile rather than quietly diluting this one leg by leg.

## Pi execution and packet

`spawn_session` is fire-and-forget: the current runner does not receive the successor's output and cannot steer it. The packet is the only thread across the chain. Complete all work and durable-state updates before handoff, then call `spawn_session` at most once as the leg's final operational action. After it returns, provide only a user-facing handoff summary; do not use more tools, mutate state, perform more Relay work, or try to steer the successor. Do not use a tracked subsession for the Relay handoff; tracked subsessions are allowed only as bounded helpers inside a leg when this profile explicitly permits them.

Default the packet root to `.pi-web/relays/<name>/` unless the preparer selects another location. During preflight, create a reviewable draft packet in the checkout where the preparation session is running and mark it not dispatched. For fresh-worktree mode, move the complete packet into the target worktree before handoff and remove the stale drafting copy. Use the base method's three durable-state files plus one profile-owned operational record:

- **`charter.md` — goal and edges.** Record Relay identity, the plain-language goal and observable finish line, minimum outcome acceptance, in-scope boundaries, explicit non-goals, material assumptions or human decisions. Keep it free of implementation plans, technical route definitions, quality bars, verification commands, review heuristics, and copied project guidance. Include a technical contract only when the user made that contract part of the desired outcome or a necessary scope edge. Changing the goal or an edge requires explicit human agreement, a charter update, and a log entry.
- **`operations.md` — runner bindings.** Record the packet and profile identity, canonical project instruction pointers, working location and Git facts, verification commands, packet isolation, commit and checkpoint policy, review budget and delivery mechanism, intervention signal, and any explicit profile adaptation. These are operating facts and policies, not product scope; maintain them without rewriting the charter.
- **`status.md` — compact baton.** Record current position, last completed leg, next leg identifier, current or next task, targeted context pointers, progress-documentation expectations, blockers, and active transition or review-decision pointers. Status selects the route; it cannot redefine the charter. Compress history out of it.
- **`log.md` — append-only history.** Append one concise entry per leg covering work and decisions, durable artifacts, verification, packet updates, and handoff or stop. Read only targeted entries referenced by charter, operations, or status; never read it end-to-end defensively.

Do not add `plan.md`, a roadmap, or generic planning/design documents to the packet. The only optional packet files in this profile are a targeted `transition.md` while a transitional checkpoint is active and a targeted `review-decisions.md` while unresolved whole-work findings require continuity. Status must link each active optional file; when that need ends, record its conclusion in the log and remove both the pointer and optional file. Put any task- or project-specific durable artifact in its canonical project or delivery location and link it through a targeted status pointer instead of expanding the packet format. If status is insufficient, repair it with targeted inspection. Intervene rather than reconstructing broad history or guessing what “done” means.

Authority follows role, not recency: charter owns destination and edges, operations owns this profile's execution bindings, status owns current position and next work, and log preserves history. Canonical repository instructions own project quality and implementation policy. None of the operational surfaces can override the charter.

## Goal and scope

Under this profile, Relay completion means the chartered outcome has been reached and every completion gate required by `operations.md`—including whole-work review, approval, and delivery—has completed. Keep those operating gates in `operations.md` rather than adding them to the charter.

Translate source material into a plain-language, observable finish line without adding outcomes. Understanding intent does not authorize extra behavior. Treat the current repository as the baseline and include only:

- work explicitly requested;
- work necessary to reach the finish line; and
- directly coupled work needed to prevent this Relay's changes from causing regressions.

Record only the minimum observable outcome acceptance and scope edges needed to recognize completion: what is in, what is explicitly out, any directly affected behavior the goal must preserve, and material assumptions or decisions. Prefer product language. Do not add technical definitions, quality criteria, speculative failure cases, or implementation constraints merely to make the charter look complete; project instructions govern quality directly. Leave optional cleanup, hardening, refactoring, and features outside the Relay unless the user approves them.

## Adaptive legs without an upfront plan

Relay intentionally does not predict the chain. Before dispatch, establish the destination and edges and select only the first bounded leg. Do not create work packages, an exhaustive stage sequence, a file/layer map, or a promised leg count. Future runners choose the next slice from current reality and the finish line.

Expected files, subsystems, dependencies, architecture, and sequencing are route assumptions. Keep only what the current or next leg needs in status or a targeted temporary artifact; do not turn route assumptions into stable agreement.

A leg is one context-contained, reviewable slice that leaves coherent durable progress toward the finish line. Prefer a functional, locally verifiable checkpoint. Keep directly coupled implementation, tests or manual checks, contracts, generated outputs, documentation, and integration glue together. Split independent responsibilities rather than splitting mechanically by file or repository layer.

Before substantial work, state the leg's:

- bounded outcome;
- primary responsibility and expected change surface;
- coupled verification;
- deferred dependencies; and
- checkpoint type: functional or profile-authorized transitional.

Persist only conclusions useful to the next runner. If uncertainty prevents responsible sizing, run a bounded discovery leg with a concrete question and durable result instead of mixing broad archaeology with implementation.

If a leg grows beyond its context-contained slice, stop broadening before context exhaustion. Finish or revert to a functional checkpoint, or use an already authorized transition. Record the next bounded slice. Do not promise a fixed total leg count.

When status does not name the next task, choose the smallest coherent slice that advances the critical path or unblocks an agreed outcome. Do not invent cleanup or speculative follow-up merely to fill a leg.

### Bounded transitional checkpoints

Use a transitional checkpoint only when a functional split would make the leg unreasonably large or require disposable compatibility work, and repository policy permits it. Before making the repository non-functioning, record a breakage budget containing:

- expected affected surfaces and failure classes;
- the last known functional commit;
- a recovery action if handoff fails;
- a named restoration milestone; and
- safety constraints.

Keep the active summary in `status.md`. Put larger details in `transition.md`, link it from status, and preserve the pointer until restoration.

A transitional leg may leave only failures inside that declared budget. The incomplete state must intentionally advance an agreed outcome, complete a coherent transformation step, and receive every focused check meaningful for that step. Every following leg while the transition is active must continue or restore it; do not start unrelated work. Never authorize a transition that creates an unsafe security, authorization, data-integrity, or irreversible external-effect state.

Treat a failure outside the budget as unexpected; resolve it or intervene rather than relabeling it after the fact. Make the checkpoint durable under the operations record's commit policy and record exact verification, recovery, and next work before handoff. If the Relay must stop before restoration, execute the recovery action unless `operations.md` explicitly permits the isolated state to remain safely available for human recovery. Do not start whole-work review or delivery until the repository is functional and final verification requirements can pass.

## Support preflight and dispatch an approved Relay

### Discover only what the packet needs

Read `AGENTS.md` and other canonical agent or contributor instructions, then follow only the references needed to establish:

- applicable project skills or quality standards every runner must use;
- focused and full verification commands, including manual checks when automation is absent;
- integration base ref and immutable base commit;
- review range and allowable pre-existing working-tree state;
- commit conventions;
- fresh-worktree bootstrap requirements, if applicable;
- review and delivery mechanism, plus an achievable fallback when remote or review tooling is unavailable; and
- packet isolation from delivery commits and the reviewed diff.

Point `operations.md` at canonical instructions instead of copying them into the packet, especially the charter. Persist only operating facts that need clarification or reinforcement. Prefer documented commands over broad repository exploration and stop discovery once the packet is runnable. If the repository has no canonical quality guidance, record that fact; do not invent a project-wide quality bar for the charter or reviewer.

If the base, existing-change ownership, target checkout, destructive-data choice, or delivery mechanism is materially ambiguous, ask rather than guess.

### Prepare the working location

During preflight, inspect and propose the working mode, base, and location. Draft packet documents may be created and revised immediately for human review. Creating a branch or worktree is also preparation rather than dispatch, but avoid unnecessary setup before the target is understood. Apply the selected mode:

- **In-place mode:** work in the invoked checkout and branch. Record checkout path, branch, integration base ref and commit, initial HEAD, pre-existing state, and exact review diff in `operations.md`. Keep unrelated existing changes out of Relay commits.
- **Fresh-worktree mode:** create a new branch and worktree from the recorded base unless the task names another target. Follow the repository's existing worktree placement; otherwise use a clear sibling location. Draft the packet in the preparation session's checkout until the target exists, then move it intact into the worktree before dispatch and set every handoff's `cwd` to that worktree. Record the dispatching checkout's state as well as worktree path, branch, and initial HEAD in `operations.md`.
- **Explicit existing location:** when the task names an existing checkout or worktree, use it and record the same operating facts as in-place mode.

In fresh-worktree mode, make leg 1 setup-only when bootstrap is required: perform the recorded bootstrap, confirm success and allowable working-tree state, then hand off without inspecting or implementing the task. If no bootstrap is needed, dispatch the first substantive leg.

Treat the Relay packet as operational state, not delivery work. Use `.pi-web/relays/<name>/` in the drafting checkout during preparation and in the selected target checkout before dispatch. Keep it outside delivery commits and the reviewed diff through an existing ignore rule, a local Git exclusion, or another non-delivery location.

### Write goal and operations separately

Keep `charter.md` short and destination-focused. Record:

- Relay identity;
- the interpreted goal and observable finish line in plain language;
- minimum outcome acceptance;
- in-scope edges, explicit non-goals, directly affected behavior that must remain unchanged, and material assumptions or human decisions.

Do **not** put a quality bar, technical design, expected files or subsystems, verification matrix, edge-case inventory, failure taxonomy, review checklist, or copied project standards in the charter. Reviewers apply the repository's current canonical skills and documentation directly, so the charter does not need to predict or paraphrase them.

Write the profile's mechanics to `operations.md` instead:

- packet identity and `relay-runner` as the profile required in every leg and handoff;
- adaptive leg sizing and critical-path task selection, with route assumptions provisional and no fixed leg count;
- pointers to canonical repository instructions and applicable project skills;
- checkpoint and transition policy;
- packet root, working location, branch, immutable base commit, initial HEAD, pre-existing state, packet isolation, and exact review range;
- focused and full verification commands;
- commit policy: every leg that changes delivery files commits all and only its changes, including intended new files, before handoff, while packet updates remain isolated;
- the two-attempt normal whole-work review/remediation policy, exceptional third-attempt contingency, and review-decision continuity;
- delivery mechanism; and
- intervention signal and triggers supplied by this profile, the user, or repository.

### Require shared understanding and approval

The preparation prompt owns the interactive preflight. Create and iteratively update goal-focused `charter.md`, profile-owned `operations.md`, compact `status.md`, and append-only `log.md` as reviewable drafts. Mark status **Draft — awaiting approval; not dispatched**. Use `ask_user` when an answer changes the goal, an edge, target, destructive-data choice, delivery mechanism, working location, or non-obvious base. Ask related questions together. This profile supplies routine mechanics, so the user approves the prepared Relay rather than designing the protocol.

After pointing the user at the final drafts, summarize the goal/edges, operating setup, and first bounded leg, then explicitly ask **Approve and dispatch**, **Revise**, or **Do not dispatch**. Never infer dispatch approval from the initial request, permission to create drafts, or the absence of objections. A material change after approval invalidates it and requires another review. On revision, update and re-present the drafts. On refusal, mark status not dispatched, append the decision, and stop. Drafting and checkout setup may happen before approval; `spawn_session` may not.

### Approved-dispatch workflow

After explicit approval, finalize all four documents, mark the packet approved, and record approval in status and log. Seed active leg tracking with last completed leg 0, the first leg identifier/task, targeted context, blockers, `review attempts: 0`, `third-attempt contingency: unused`, and any active pointers. In fresh-worktree mode, move the packet into the target worktree, update recorded paths and location facts, and remove the stale drafting copy before handoff.

Dispatch exactly one first leg with `spawn_session`, after all state is durable in its final location. Use the selected checkout/worktree as `cwd`. After `spawn_session` returns, report the Relay name, packet path, location and branch, interpreted finish line and material non-goals, delivery target, first leg, and dispatch confirmation. Perform no further operational action and never promise a total leg count.

## Run every leg

Use this loop:

1. Read `charter.md`, `operations.md`, `status.md`, and only targeted context they reference. Then load canonical project skills applicable to this leg.
2. Confirm that the prompt's leg identifier, status baton, working location, branch, and blockers are consistent. Resolve small baton defects with targeted inspection; intervene instead of broad archaeology or guessing about intent.
3. Choose the explicit next task from status when it fits the charter and leg size. Otherwise apply the operations record's critical-path task-selection policy. If the task remains ambiguous or falls outside the finish line, intervene.
4. Re-anchor to the finish line and perform the containment check. Do exactly one bounded slice. Do not audit unrelated code, execute the next nominal leg too, or expand scope under the guise of quality.
5. Run every focused check meaningful for the slice and report exact results. Before whole review, run the full verification named by `operations.md`. Never describe failed, skipped, or incomplete verification as passing.
6. Make delivery changes durable under the operations record's commit policy without absorbing unrelated state. Keep packet-only writes out of delivery commits.
7. Update status with the new position, completed and next leg identifiers, next task or selection pointer, targeted context, verification state, blockers, and active transition/review pointers. Append the concise leg entry to the log before stopping or handing off.
8. Stop without spawning when Relay completion is recorded, the leg is blocked, or an intervention trigger fires. When the chartered outcome is implemented but required review, approval, or delivery remains, name that lifecycle work as the next leg instead of stopping. Surface the intervention signal clearly. Otherwise hand off exactly once at the end with `spawn_session`.

Use this handoff shape, substituting the actual paths and next identifier:

```text
Relay "<name>" leg <identifier> begins now.

Work under the Relay method with the `relay-runner` operational profile.
Load the `relay` and `relay-runner` skills, then read:
- .pi-web/relays/<name>/charter.md
- .pi-web/relays/<name>/operations.md
- .pi-web/relays/<name>/status.md

Do not read log.md end-to-end. Use only targeted entries referenced by charter.md, operations.md, or status.md.
Run exactly one leg, make its work and packet updates durable, then either hand off once or stop with the recorded intervention signal.
```

## Whole-work review and remediation

Run whole-work review immediately before delivery and only after implementation and verification are believed complete and no transition remains active.

Approval means the reviewed evidence reasonably demonstrates the chartered finish line under the repository's canonical quality guidance; it does not claim the work is perfect or free of every possible defect. Reviewers are not expected or rewarded to produce findings. A clean approval is the correct result when no concretely supported blocker is found.

Use **two normal whole-work review attempts** from implementation-complete through delivery: the initial review and, only when needed, one post-remediation or pre-delivery re-review. A third review is an exceptional contingency, not routine capacity or a target. Invoke it only under the attempt 2 finding rule below or when delivery finds that materially changed review inputs made the prior approval stale. Record `review attempts: N` and `third-attempt contingency: unused` in status, changing the contingency field to `invoked — <reason>` before using it. Append each attempt, base, and HEAD to the log. Focused subreviews consolidated by one reviewer are part of one attempt, not separate attempts.

Attempt 1 is the only broad, proportionate review pass. Report its concretely supported blockers together rather than serializing already-known concerns across later attempts; this calls for a proportionate pass, not an exhaustive search. Later reviews still judge the exact delivery diff as a whole, but carry prior decisions forward and focus on remediation, changed evidence, and regressions. Do not restart review from zero, expand the audit surface, or apply a newly stricter standard because another attempt is available.

For each attempt:

- Review the exact delivery diff recorded in `operations.md` against the charter's goal and edges and the repository's canonical quality instructions. Do not derive a technical bug-hunting checklist from incidental charter wording.
- Keep the reviewer report-only for implementation and delivery artifacts. Its only writes are packet updates needed to record review and handoff.
- Confirm the full verification required by `operations.md` at the reviewed HEAD and record exact results.
- Approve when no blocking finding meets the evidence threshold below, even if non-blocking limitations or theoretical risks remain. Record exact reviewed base and HEAD, point status at the approval, and name delivery as next.
- When attempt 1 has blocking findings, record them in risk order in the log, name one coherent remediation leg in status with a targeted pointer, and dispatch it. Remediation runners resolve the recorded blockers in bounded slices and dispatch attempt 2 only after the attempt 1 report has been addressed; do not spend another whole-work review merely to reveal the next already-known item.
- When attempt 2 has a blocking finding, do not automatically consume attempt 3. Invoke the remediation contingency only when concrete evidence shows that an attempted remediation reasonably expected to resolve a blocker did not, remediation introduced an in-scope regression, or materially new evidence reveals a blocker that could not reasonably have been assessed earlier—and one bounded remediation is likely to resolve it. Record that justification, mark the contingency invoked, and dispatch one coherent remediation leg followed by attempt 3. Expanded scrutiny, a changed standard, deferred already-available evidence, or speculative possibility does not qualify. If a genuine blocker remains but the contingency is not justified or bounded, intervene.
- When exceptional attempt 3 still has any blocking finding, stop the automatic loop. Record the unresolved findings and exact decision needed, raise the human intervention signal, and do **not** dispatch remediation or a fourth review. A human may accept an authorized risk, change the agreement, stop the Relay, or explicitly grant a bounded additional remediation/review attempt.

The reviewer chooses proportionate independent review and records that decision. Independent subreviews are optional; use them only when a specific changed surface benefits from focused expertise, not to create review theater or increase the chance of finding something. The reviewer may use `spawn_subsession` for report-only focused reviews, then `yield_to_subsessions` and consolidate. Subreview prompts must identify repository, base and exact diff, the charter's goal and edges, canonical quality instructions, and the prohibition on all writes including packet changes. The consolidating reviewer is the sole packet writer. Do not assume a particular model is available. The Relay handoff still uses one `spawn_session` only at the end of the leg.

A blocking finding needs concrete evidence of an in-scope defect: for example a reproduced failure, a failing relevant check, a specific execution path that violates the approved outcome, or a clear breach of a material contract, invariant, security, authorization, or data-integrity boundary. Mere possibility, stylistic preference, optional hardening, hypothetical future requirements, or “there could be an edge case” is not blocking. If proportionate targeted inspection cannot establish applicability and impact, classify the concern as non-blocking or omit it rather than forcing remediation.

Review cannot over-specify the agreement. Decide materiality from the charter's goal and edges and the repository's canonical guidance, not from a reviewer-created standard. A concern outside those authorities is non-blocking or out of scope even when it describes a possible improvement. Non-blocking findings do not prevent approval or consume a remediation leg. Do not turn review into an audit of unrelated pre-existing shortcomings.

### Review-decision continuity

Create `review-decisions.md` only when a finding disposition must survive into later reviews. Point to it from status continuously through remediation and delivery; later reviewers read it instead of reconstructing history from the log.

Give recurring findings stable identifiers. Record concern, disposition, concise rationale, evidence, authority, applicability, and revisit conditions. A remediated decision cites the fixing commit and verification. Not-applicable cites concrete evidence. Accepted-risk or out-of-scope cites an exact charter edge, canonical project guidance, or explicit human direction. Do not create speculative risk analyses merely to populate the register.

Do not duplicate an existing finding. Honor supported decisions while facts remain unchanged, but reopen for materially new evidence, changed applicability, or a demonstrable error or charter conflict. Record what supersedes the old decision. A reviewer cannot unilaterally waive an in-scope defect.

Keep the register compact and current. It is subordinate to the charter: changing the goal, minimum outcome acceptance, or a scope edge requires human agreement, a charter update, and a log entry.

## Delivery finish

The final leg performs only the delivery mechanism recorded in `operations.md`.

1. Read the targeted approval entry cited by status.
2. Verify that the integration base still resolves to the reviewed base commit, HEAD equals the reviewed HEAD, and the working tree matches the allowable state recorded in `operations.md`, normally clean apart from the packet.
3. If the base advanced or expected in-scope work changed, intervene when the mismatch is unrelated, unexpected, or of unclear ownership. Otherwise dispatch a fresh whole-work review when a normal attempt remains. After two attempts, invoke the exceptional third only when the changed inputs materially invalidate the prior approval and a targeted review can assess the new exact range; record that reason before dispatch. If neither condition applies, intervene.
4. Create or update the recorded pull/merge request, push the branch, produce the agreed patch, or leave the agreed clean committed local branch. Do not invent delivery infrastructure the repository does not use.
5. State what changed and why, behavioral or contract changes, migration or deployment ordering when applicable, and exact verification with results.
6. Record the delivery result—URL, pushed branch, patch path, or local commit/branch—in status and log before declaring completion. Required push, authentication, or review-tool failure is intervention, not completion.

## Intervention triggers

Stop, update status, append the log, surface the intervention signal recorded in `operations.md`, and do not spawn when:

- the finish line or a stable outcome must change without explicit human agreement;
- the environment is unusable;
- destructive-data behavior is ambiguous;
- a product or business decision lies outside the charter;
- proceeding would knowingly weaken a material invariant or security/authorization boundary;
- unexpected unrelated branch changes make ownership or the review range unclear;
- required delivery or authentication fails;
- review remains blocked after the normal attempts and the third-attempt contingency is unavailable or exhausted;
- the finish line is infeasible; or
- another user-, repository-, charter-, or operations-defined trigger fires.

Ordinary implementation defects stay within the agreed route and review findings go through remediation. Neither justifies changing scope, ignoring canonical project guidance, or relabeling unexpected breakage as transitional.
