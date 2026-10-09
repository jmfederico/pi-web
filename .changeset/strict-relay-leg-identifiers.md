---
"@jmfederico/pi-web": patch
---

Require Relay dispatch leg identities to be strings such as `"2"` or `"R1-a"`. Reject non-string values before Pi can coerce them into an unintended identity.
