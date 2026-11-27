---
"@jmfederico/pi-web": patch
---

When Pi is older than PI WEB supports, the Updates panel recommends **Update Pi**, which runs `pi update` in the maintenance terminal on global npm and Pi-package installs. Restart PI WEB afterwards; the panel keeps restart as a separate action. `pi-web doctor` also names `pi update`.

Plugin API: `PiWebStatusResponse.commands.updatePi` is new. `PiWebStatusMessage.command` is deprecated and no longer set; use `PiWebStatusResponse.commands`.
