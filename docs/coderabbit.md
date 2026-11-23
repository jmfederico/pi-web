# CodeRabbit reviews and automatic merging

CodeRabbit reviews non-draft pull requests to the default branch, including contributions from other authors, and reviews subsequent pushes. `.coderabbit.yaml` maps repository guides to the files they govern. Architecture guidance lives in [the architecture skill](../.agents/skills/code-quality-architecture/SKILL.md), including plugin/package-first placement.

## Actual review approval

Automatic Approvals lets CodeRabbit submit GitHub `APPROVED` or `CHANGES_REQUESTED` reviews. A green CodeRabbit check or a comment saying there are no findings is not an approval.

Normal approval requires a completed review of the current commit, resolved required findings, and passing CodeRabbit pre-merge checks. GitHub's CI requirements are separate. Author-issued blanket `approve` and `resolve` commands are disabled; address findings and request another review instead. Do not use those commands to clear unresolved findings on someone else's behalf either.

The public-repository offer currently includes reviews and approvals without a paid subscription, subject to CodeRabbit's rate and file limits. This configuration does not enable paid overages. Account billing and optional products remain account-level settings, not guarantees made by this repository.

## Automatic merge policy

The `CodeRabbit merge` workflow checks open PRs after CI completes, approximately every ten minutes, or on manual dispatch. Scheduled runs can be delayed by GitHub. It merges directly after checking eligibility; it does not leave GitHub's native auto-merge switch armed while waiting for a future approval.

It only merges a PR when:

- Its author is `jmfederico` or the personal `federico-agent[bot]` App (verified GitHub account ID `356431845`), its branch belongs to this repository, its target is `main`, and it is open and not a draft. The agent's own reviews cannot substitute for CodeRabbit approval.
- It has no `do-not-merge` label.
- It does not change review or automation policy: `.github/**`, `.agents/**`, `AGENTS.md`, or `.coderabbit.yaml`. Renaming those files also requires a manual merge.
- CodeRabbit's latest effective approval is for the current head commit. Comments, stale approvals, dismissed approvals, and approvals from other reviewers do not qualify.
- GitHub reports the PR ready to merge under the repository's rules.

The workflow rechecks the PR and reviews before making a SHA-guarded merge-commit request. GitHub enforces required CI, approving reviews, and resolved review conversations. The merge identity must have no ruleset bypass. GitHub cannot atomically bind a merge to a particular review version; a simultaneous approval dismissal remains a narrow race, even with the final recheck.

Other authors' PRs receive CodeRabbit reviews but are left for maintainer merging. Maintainers can also manually merge policy changes after review. Administrator bypass remains an explicit manual escape hatch, not something the automation uses.

### GitHub rules

The active `main` ruleset should retain all five required CI checks and require:

- One approving review.
- Dismissal of stale approvals after new commits.
- Resolution of review conversations.

One required approval permits either a human or CodeRabbit approval for manual merging. The automation separately requires CodeRabbit's actual current-head approval. Do not replace that distinction with the CodeRabbit check's success status.

## One-time activation

The workflow is disabled unless repository variable `CODERABBIT_MERGE_ENABLED` is `true`.

Use a GitHub App, rather than Actions' built-in `GITHUB_TOKEN`: merges made with that token can suppress the normal post-merge CI and documentation deployment events. The personal `federico-agent` App can serve both agent work and merging; CodeRabbit remains the independent reviewer. Do not copy a personal GitHub token into this workflow.

1. Use the `federico-agent` App owned by `jmfederico`, or a separate merge App, with webhooks disabled. No user authorization callback is needed for installation-token authentication.
2. The merge workflow needs repository **Contents: Read and write**, **Pull requests: Read and write**, and the mandatory **Metadata: Read-only** permission. It requests a token restricted to those permissions and `pi-web`, even if the personal App has broader access for agent work. Do not add the App to any ruleset bypass list.
3. Install the App with access to `jmfederico/pi-web` and generate a private key. The personal App can also be installed on other repositories; the merge token does not include them.
4. Save its App ID as repository variable `CODERABBIT_MERGE_APP_ID`. Save the PEM key as Actions secret `CODERABBIT_MERGE_PRIVATE_KEY`. Never commit or paste the key into chat.
5. Confirm the `main` rules above, then set repository variable `CODERABBIT_MERGE_ENABLED` to `true` and manually run `CodeRabbit merge`. Enabling it applies to existing eligible PRs as well as future ones; label any PR that should wait with `do-not-merge` first.

The workflow uses pinned actions and trusted default-branch code. It never checks out or executes a PR branch, installs PR dependencies, or downloads PR artifacts.

### Pause and recovery

- Set `CODERABBIT_MERGE_ENABLED` to `false` to pause automatic merging globally. Cancel an already-running merge job as well when an immediate pause is needed.
- Apply `do-not-merge` to pause an individual PR before it becomes eligible. A label applied concurrently with a final merge request is not an atomic cancellation.
- Inspect failed workflow runs for expired/revoked credentials, missing permissions, or API failures. Errors do not count as approval.
- Request a fresh CodeRabbit review after a push if its review is missing or rate-limited. Use a manual workflow dispatch to check eligibility again without waiting for the schedule.

## Agent management

Agents can maintain `.coderabbit.yaml`, inspect actual GitHub reviews, discuss findings, and request reviews using existing GitHub access. Separate CodeRabbit credentials are not needed for those operations. Keep configuration changes reviewable, preserve the merge rules, and never manufacture approvals or bypass checks to clear a blocked PR.

CodeRabbit account billing, users, and optional direct API/MCP access are separate from this repository workflow.

References: [CodeRabbit approvals](https://docs.coderabbit.ai/pr-reviews/automatic-approvals), [guideline mapping](https://docs.coderabbit.ai/knowledge-base/code-guidelines), [plans](https://docs.coderabbit.ai/management/plans), and [GitHub token event behavior](https://docs.github.com/en/actions/concepts/security/github_token).
