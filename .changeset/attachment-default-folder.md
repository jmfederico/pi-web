---
"@jmfederico/pi-web": patch
---

Add an `attachments.defaultFolder` config key to customize where chat-composer prompt attachments are saved, mirroring `uploads.defaultFolder`: set it in the global config file or Settings → General for the selected machine, override it per project in `<project>/.pi-web/config.json`, and see the workspace-effective folder in the composer's "Save to …" delivery option. Without configuration, attachments are still saved to `.pi-web/attachments`, and an explicit per-request folder keeps winning over the configured default.
