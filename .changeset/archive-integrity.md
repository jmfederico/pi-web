---
"@jmfederico/pi-web": patch
---

Make session archival safer. When a transcript changes during archival or its original cannot be removed, the failure is reported and the session stays unarchived; if the archive index cannot be rolled back, the archive stays indexed for a retry or restore. Retrying an archive whose original was left behind finishes cleanup or reports a conflict instead of reporting success, and restoring it keeps the newer original. Session IDs must be unique: archival stops and names the files when it finds more than one transcript for an ID. Archival also includes running tracked subsessions even when their spawn link was not saved, and declines a tree selection made stale by detaching a child.
