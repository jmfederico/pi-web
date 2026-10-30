---
"@jmfederico/pi-web": patch
---

Expose session pin, unpin, archive, restore, and archived-session deletion to browser and server plugins using explicit session identities. Pins protect cleanup without blocking deliberate plugin commands. Expose creation, modification, archive timestamps, and pin state through session discovery so plugins can implement their own age filters and cleanup policies without a cleanup-specific API. These metadata fields are always present; unknown dates are explicitly `null`.

Use the same native lifecycle guards for core cleanup and explicit plugin archive/delete commands.

Move session pins to daemon-owned storage, preserving existing pins. Upgrade/restart the web/API process before restarting the session daemon; do not leave an older web/API process writing pins after the migration. Session-daemon restarts interrupt active sessions and terminals.
