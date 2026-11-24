---
"@jmfederico/pi-web": patch
---

Make session archival safer when transcripts change or are ambiguous. Messages appended while a session is being archived are kept. When the original cannot be safely removed, the failure is reported. A newly archived session is returned to unarchived when its complete original is back in place and the archive index can be updated. Otherwise the archive stays indexed, including an archive that already existed, so a retry or restore can complete it. Retrying an archive whose original was left behind finishes cleanup or reports a conflict instead of reporting success, and restoring it keeps the newer original. Archival refuses sessions with more than one transcript under the same ID, includes running tracked subsessions even when their spawn link was not saved, and declines a tree selection made stale by detaching a child.
