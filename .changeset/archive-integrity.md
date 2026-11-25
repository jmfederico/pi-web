---
"@jmfederico/pi-web": patch
---

Make session archival safer. When a transcript changes during archival or its original cannot be removed, the failure is reported and the session stays unarchived; if the archive index cannot be rolled back, the archive stays indexed for a retry or restore. Retrying an archive whose original was left behind finishes cleanup or reports a conflict instead of reporting success, and restoring it keeps the newer original. Archival refuses a selected session whose ID belongs to more than one transcript, includes running tracked subsessions even when their spawn link was not saved, and declines a tree selection made stale by detaching a child.
