---
"@jmfederico/pi-web": patch
---

Allow unrelated environment variables when checking managed systemd services while still rejecting directly configured `PI_WEB_CONFIG` mismatches. Accept `EnvironmentFile=` with a nonfatal warning that file-based config overrides cannot be verified; readiness checks use the installed config path unless explicitly overridden for the command.
