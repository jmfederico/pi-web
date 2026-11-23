---
"@jmfederico/pi-web": patch
---

Keep chat follow-scroll correct when a block expands inside a nested shadow root. Tool cards and rendered markdown open disclosures in their own shadow tree, so their `toggle` event never reaches the transcript; the transcript now observes its top-level blocks for size changes and recalculates its scroll layout when one grows.
