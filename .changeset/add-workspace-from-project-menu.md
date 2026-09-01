---
"@jmfederico/pi-web": patch
---

Add workspace creation to the project menu. The project "⋯" menu now offers "Add workspace", which opens a folder browser starting in the project's parent directory and asks for a workspace name; the bundled Git provider slugifies that name into a branch and runs `git worktree add` in a visible terminal command run, attaching an existing local branch of the same name instead of failing. Server plugins opt in with the new optional `WorkspaceProvider.prepareCreate()` contract, and the action stays hidden for providers that do not implement it.
