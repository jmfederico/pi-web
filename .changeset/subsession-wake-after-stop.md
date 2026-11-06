---
"@jmfederico/pi-web": patch
---

Allow subsession lifecycle notices to wake an idle parent after Stop or an earlier error. Retry notices missing from the conversation up to three times with backoff, without replaying notices already inserted or retrying agent failures. Show delivery errors when retries are exhausted and retain unread notices for later recovery.
