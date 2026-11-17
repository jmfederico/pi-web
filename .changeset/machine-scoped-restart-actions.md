---
"@jmfederico/pi-web": patch
---

Make Restart target the selected machine and share restart handling across the action menu, Updates, and Settings. Updates and Settings now offer direct, service-specific restart buttons with machine and interruption warnings; the generic Restart action keeps its confirmation dialog. Wait for the target machine's Terminal plugin before launching, and keep the gateway web restart shortcut available across Settings visits because active host and port settings cannot be confirmed. Show pending feedback in Updates only while preparing and launching the terminal command, not while services restart. Add a machine-scoped restart capability for browser v5 plugins with explicit cancelled or launched outcomes.
