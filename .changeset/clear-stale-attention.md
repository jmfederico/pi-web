---
"@jmfederico/pi-web": patch
---

Keep a session's **Needs input** state and its open question form in step. Both now close when the conversation continues, including a message sent before the question that is delivered after it. Passive entries, such as extension notices or shell output, leave both open.
