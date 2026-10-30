---
"@jmfederico/pi-web": patch
---

Let agents stop, resume, and archive their tracked children through a single `manage_subsession` tool, and send messages to other sessions in the same project without creating a parent/child relationship. Session messaging is enabled by default and can be disabled independently with `sessionMessages` or `PI_WEB_SESSION_MESSAGES`. Children receive their parent’s session ID, and messages identify the sending session so recipients can reply without guessing identities. Automatic child notifications report idle or error state without forwarding final output or claiming the task is complete; agents can coordinate through messages or explicitly inspect a child’s output. Stop interrupts the current run without preventing later messages from starting another turn. Restart the session daemon after updating to enable the new tools.
