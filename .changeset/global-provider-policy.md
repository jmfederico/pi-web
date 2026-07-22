---
"@jmfederico/pi-web": patch
---

Require Pi Coding Agent `>=0.81.1 <0.82` and build an immutable provider baseline at session-daemon startup. Globally installed Pi extensions can register both config-form and native providers during startup bootstrap; every later Pi extension registration or unregistration—including global replay, project same-ID replacement, lifecycle callbacks, and `/reload`—is ignored. PI WEB browser plugins are a separate browser-only system and are unaffected. Non-provider Pi extension features still work, and ignored calls are de-duplicated in session-daemon logs by operation/provider ID without logging provider configuration or credentials or creating session warnings/notifications.

After updating PI WEB, or after installing, removing, or updating a globally installed Pi extension that registers providers, manually restart `pi-web-sessiond.service` (`systemctl --user restart pi-web-sessiond`). Restarting only the web/API service and running `/reload` do not rebuild the provider baseline.
