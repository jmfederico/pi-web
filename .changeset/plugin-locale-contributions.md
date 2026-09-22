---
"@jmfederico/pi-web": minor
---

Add plugin-based interface localization: browser plugins can contribute locale dictionaries through `contributions.locales`, browser language packs are marked in package metadata and stay loadable when Terminal cannot start, and the Settings → General language selector is generated from installed packs. The Simplified Chinese catalog moved out of the core bundle into an installable reference pack at `locale-packs/pi-web-locale-zh-cn/`.
