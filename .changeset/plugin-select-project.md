---
"@jmfederico/pi-web": minor
---

Let browser plugins select a project through the runtime context. `selectProject(projectId, { workspaceId })` routes through the same navigation seam as a sidebar click, so focus advance, chat scroll transition, and the URL stay consistent, and it resolves `false` for an id the selected machine does not have.
