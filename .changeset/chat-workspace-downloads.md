---
"@jmfederico/pi-web": patch
---

Open relative chat Markdown file links (including `./` paths and redundant separators) and absolute paths inside the session workspace in the Files panel through an optional plugin file-opening hook. Keep downloads as the fallback when no enabled panel handles the file, and for modifier/new-tab clicks. Preserve web, email, anchor, and other root-relative links.
