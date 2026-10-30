---
"@jmfederico/pi-web": patch
---

Deliver the default theme with the initial page so the app opens with its palette ready. Load other themes on demand, cache their assets, and retain a usable palette if loading fails. General settings load the full theme inventory with a retry option. Show a pulsing startup logo, static for reduced motion, with teal branding for stable instances and purple for development instances.

Support declarative CSS-only theme packages without browser JavaScript or a server module. Existing theme IDs, saved preferences, and configuration precedence are preserved; legacy runtime themes remain supported but are deprecated.
