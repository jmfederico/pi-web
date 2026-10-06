---
"@jmfederico/pi-web": patch
---

Add application plugin tabs that work without a selected workspace. Info now shows machine and PI WEB status before a project or session is selected, with workspace details added when available. Updates offers status guidance and copyable commands without a workspace, with Run available only through a selected workspace's Terminal provider. Browser API v4 remains compatible, with fresh basic selection snapshots and warnings for unknown contribution names. Plugins can read the current selection and subscribe while their panels are closed; subscriptions stop with plugin lifetime or an earlier unsubscribe, and subscriber failures are isolated. Public action and panel contexts also offer read-only registered-project listing and directory suggestions on a captured machine target; remote failures never substitute gateway projects.
