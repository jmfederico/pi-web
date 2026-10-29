---
"@jmfederico/pi-web": patch
---

Prevent intermediate frame jumps in experimental transcript windowing by completing mounted renders before scroll correction. Preserve fractional-pixel precision across scrolling and reader-anchor changes, and avoid unnecessary scroll assignments when an anchor is already aligned.
