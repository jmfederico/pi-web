---
"@jmfederico/pi-web": patch
---

Provision shipped automatic Pi packages once per agent profile so removals through `pi remove` or manual package-settings edits persist across daemon restarts. Preserve existing Settings dismissals, retry failed initial installs, and keep configured copies aligned with the running PI WEB version without changing resource filters. Explicit reinstall remains available. Older CLI or manual removals without a provisioning record may receive one final automatic reinstall during rollout.
