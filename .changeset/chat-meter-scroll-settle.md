---
"@jmfederico/pi-web": patch
---

Fix chat scrolling on touch devices freezing mid-gesture: the conversation position indicator no longer repaints while a scroll gesture or momentum scroll is in flight, and instead catches up once the scroll settles.
