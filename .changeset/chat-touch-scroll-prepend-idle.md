---
"@jmfederico/pi-web": patch
---

Fix chat history scrolling on touch devices stopping suddenly: earlier messages are now fetched in the background but only inserted into the chat once the scroll gesture and momentum settle, so scroll-position corrections no longer cancel an in-flight touch scroll.
