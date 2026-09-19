---
"@jmfederico/pi-web": patch
---

Keep phone-height dialog actions reachable: dialogs size against the padded backdrop (percentage max-height, dvh-based top padding, safe-area bottom padding) so Cancel and primary actions stay on screen, and the Add-project body scrolls when space runs out. Mobile context chips cap at min(60vw, 240px) with ellipsized values, and hidden mobile tab labels no longer widen the shell.