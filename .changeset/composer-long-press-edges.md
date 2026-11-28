---
"@jmfederico/pi-web": patch
---

Fix the native edit menu (Paste, Select) not reliably appearing on long press in the empty chat input on iPhone and iPad. The input's empty-state hint no longer sits inside the editable line, so the editor no longer moves the caret under your finger, and the whole input box now responds to long press, including its top and bottom edges.
