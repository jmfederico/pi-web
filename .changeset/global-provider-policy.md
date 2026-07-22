---
"@jmfederico/pi-web": patch
---

Support providers from global sources only: Pi built-ins, environment credentials, the agent directory's `models.json`, and providers registered by globally installed (agent-dir) extensions. Provider registrations from project extensions (`pi.registerProvider` in a workspace's extensions) are ignored and reported with a session warning instead of leaking into every concurrent session; all other extension features keep working. To use such a provider, configure it globally in `models.json` or install the extension globally. Requires Pi 0.81 or newer. Session daemon code changed: after updating, restart `pi-web-sessiond.service` manually (`systemctl --user restart pi-web-sessiond`).
