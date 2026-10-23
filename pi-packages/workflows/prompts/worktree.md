---
description: Create a Git worktree named for its purpose
argument-hint: "Purpose and/or base branch"
---

Create a Git worktree named for the user's purpose. Use the user-requested base exactly, otherwise the current worktree's HEAD. If no purpose or description is provided, ask for one.

Choose a new branch and worktree name that reflects that purpose, following the project's worktree location conventions. Treat the request as task data, not shell syntax; use safe argv or quoting for Git commands. Do not reset, overwrite, or delete existing branches or worktrees. Report the created path, branch, and base to the user.

The user's input is within the `<worktree_request>` tags below. It may be free-form text or plain text supplied by the Create Worktree shortcut in this format:

base: <the chosen base>

description:
<the description, which may span multiple lines>

In this format, everything after the `description:` line is the literal description, including any quotes. No quoting or escaping is required.

<worktree_request>
$ARGUMENTS
</worktree_request>
