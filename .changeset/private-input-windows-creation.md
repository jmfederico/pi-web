---
"@jmfederico/pi-web": patch
---

Reject dangling destination symlinks when saving private input on Windows instead of creating their targets. Windows capture now requires a filesystem that supports hard links; existing files and symlinks remain untouched.
