---
"@jmfederico/pi-web": patch
---

Separate responsive panel selection (`view=navigation|chat|workspace`) from workspace tab selection (`tool`). Invalid views show warnings and usable display fallbacks without rewriting the URL; tab IDs in `view` are no longer accepted. Unavailable tools show their message inside the workspace panel without a duplicate warning.
