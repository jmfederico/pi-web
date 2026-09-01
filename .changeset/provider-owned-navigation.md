---
"@jmfederico/pi-web": minor
---

Let a workspace provider own the navigation it implies: `publicMetadata.navigation.hideProjects` removes the project section (and the mobile project crumb) while one of that provider's workspaces is selected, and `publicMetadata.navigation.workspacesTitle` renames the workspace section. Values of the wrong shape are ignored rather than trusted.
