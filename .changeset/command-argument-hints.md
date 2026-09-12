---
"@jmfederico/pi-web": patch
---

Show prompt template argument hints in the web prompt editor: slash command autocomplete now displays each template's `argument-hint` (for example `<PR-URL>` or `[instructions]`) next to the command name, and picking a command shows the hint as ghost text in the editor until you start typing. The `/name` and `/compact` builtins declare their expected arguments too.
