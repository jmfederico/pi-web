---
"@jmfederico/pi-web": patch
---
Reduce slowdowns from long running chats by reusing usage statistics instead of recalculating them on every streamed update. Running state, queues, and questions still update promptly; token totals, cost, and context usage refresh on the next two-second heartbeat when their inputs change.
