---
"@jmfederico/pi-web": patch
---

Add an experimental, default-off Safe Tunnel flow that operators can activate with global `safeTunnel: true` or `PI_WEB_SAFE_TUNNEL=1`, then use to approve one machine and run one PI WEB-owned, structurally constrained `frpc` tunnel. Availability and trusted-host changes require a web/API restart; enabled intent makes one restore attempt after restart, while unexpected child exits stay stopped until the operator retries. Browser APIs expose only bounded PI WEB-authored progress and errors, public exposure still requires an ingress that authenticates users, and the managed `frpc` path supports Linux arm64 and x64.
