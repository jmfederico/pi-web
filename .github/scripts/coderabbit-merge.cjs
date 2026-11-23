const repository = { owner: "jmfederico", repo: "pi-web" };
const repositoryName = "jmfederico/pi-web";

function ineligibleReason(pr) {
  if (pr.state !== "open" || pr.draft !== false) return "not an open, non-draft PR";
  const ownerAuthored = pr.user?.login === "jmfederico";
  const agentAuthored = pr.user?.id === 356431845 && pr.user?.login === "federico-agent[bot]" && pr.user?.type === "Bot";
  if (!ownerAuthored && !agentAuthored) return "author is not Federico or his agent";
  if (pr.head?.repo?.full_name !== repositoryName) return "head is not in this repository";
  if (pr.base?.repo?.full_name !== repositoryName || pr.base?.ref !== "main") return "base is not this repository's main";
  if (pr.labels.some((label) => label.name === "do-not-merge")) return "do-not-merge label is set";
  if (pr.mergeable !== true || pr.mergeable_state !== "clean") return "GitHub has not reported clean mergeability";
  return null;
}

function approved(reviews, sha) {
  // Comments and pending reviews do not replace a submitted review decision.
  // A later dismissal or changes-requested decision must not revive an old approval.
  const decisions = reviews.filter((review) =>
    review.user?.id === 136622811 && review.user?.login === "coderabbitai[bot]" &&
    review.state !== "COMMENTED" && review.state !== "PENDING",
  );
  decisions.sort((a, b) =>
    (Date.parse(b.submitted_at) - Date.parse(a.submitted_at)) || b.id - a.id,
  );
  const latest = decisions[0];
  return latest?.state === "APPROVED" && latest.commit_id === sha;
}

function sensitivePath(path) {
  return path === "AGENTS.md" || path === ".coderabbit.yaml" ||
    path === ".github" || path.startsWith(".github/") ||
    path === ".agents" || path.startsWith(".agents/");
}

module.exports = async function reconcile({ github, core }) {
  const pulls = github.rest.pulls;
  const candidates = await github.paginate(pulls.list, {
    ...repository, state: "open", base: "main", per_page: 100,
  });

  for (const candidate of candidates) {
    // List responses omit mergeability; fetch full state before any decision.
    const params = { ...repository, pull_number: candidate.number };
    const notice = (reason) => core.notice(`PR #${candidate.number}: ${reason}`);
    const { data: pr } = await pulls.get(params);
    const reason = ineligibleReason(pr);
    if (reason) {
      notice(reason);
      continue;
    }

    const sha = pr.head.sha;
    const reviews = await github.paginate(pulls.listReviews, { ...params, per_page: 100 });
    if (!approved(reviews, sha)) {
      notice("no current-head CodeRabbit approval");
      continue;
    }

    const files = await github.paginate(pulls.listFiles, { ...params, per_page: 100 });
    // GitHub caps the files endpoint at 3,000. Never authorize a partial diff.
    if (files.length !== pr.changed_files) {
      notice("incomplete changed-file list; manual merge required");
      continue;
    }
    if (files.some((file) => sensitivePath(file.filename) ||
      (file.previous_filename && sensitivePath(file.previous_filename)))) {
      notice("sensitive paths changed; manual merge required");
      continue;
    }

    // Recheck mutable metadata and approval immediately before the write. A base
    // change also invalidates the inspected file list, even with the same head.
    const { data: current } = await pulls.get(params);
    const currentReason = ineligibleReason(current);
    if (currentReason || current.head.sha !== sha || current.base.sha !== pr.base.sha) {
      notice(currentReason || "head or base changed during inspection");
      continue;
    }
    const currentReviews = await github.paginate(pulls.listReviews, { ...params, per_page: 100 });
    if (!approved(currentReviews, sha)) {
      notice("CodeRabbit approval changed during inspection");
      continue;
    }

    // The App must have no ruleset bypass. GitHub enforces required reviews,
    // resolved threads, and CI; the SHA precondition rejects concurrent pushes.
    // GitHub has no equivalent atomic precondition for a specific review ID.
    try {
      const { data: result } = await pulls.merge({ ...params, sha, merge_method: "merge" });
      if (result.merged) core.info(`Merged PR #${candidate.number} at ${sha}`);
      else notice(`GitHub declined merge: ${result.message}`);
    } catch (error) {
      if (error.status === 405 || error.status === 409) {
        notice(`GitHub declined merge after readiness changed (HTTP ${error.status})`);
      } else {
        throw error;
      }
    }
  }
};
