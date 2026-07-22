---
"@jmfederico/pi-web": patch
---

Expand a changed submodule in the Git panel to see the work inside it. Tree view nests the submodule's own modified and untracked files (keeping their folder structure) and list view flattens them into one group, with a moved commit pointer shown as `<old> → <new>` when it changed. Selecting any inner file shows its real diff instead of the bare `Subproject commit` line.
