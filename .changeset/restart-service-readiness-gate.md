---
"@jmfederico/pi-web": patch
---

Fix `pi-web restart` on macOS reporting success while LaunchAgents could disappear: the CLI now waits for each `launchctl bootout` to finish unloading before re-bootstrapping the service instead of racing launchd's asynchronous teardown, and the install path settles the same way. `pi-web start` and `pi-web restart` now also verify on macOS and Linux that each service is actually running and responsive (web/API endpoint, session daemon health), exiting nonzero and naming the unready service instead of succeeding silently. These readiness checks and `pi-web doctor` automatically use the custom config path persisted by `pi-web install --config` unless the command is invoked with a nonempty `PI_WEB_CONFIG` override, and fail safely when the service manager has a conflicting loaded definition; malformed systemd environment entries are rejected without stalling lifecycle commands.
