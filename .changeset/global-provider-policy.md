---
"@jmfederico/pi-web": patch
---

Support only globally configured providers (Pi built-ins, environment credentials, and the agent directory's `models.json`). Provider registrations from Pi extensions (`pi.registerProvider`) are now ignored and reported with a session warning instead of leaking into every concurrent session; all other extension features keep working. Configure such providers globally in the agent directory's `models.json` to use them. Session daemon code changed: after updating, restart `pi-web-sessiond.service` manually (`systemctl --user restart pi-web-sessiond`).
