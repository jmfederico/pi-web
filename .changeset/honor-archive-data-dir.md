---
"@jmfederico/pi-web": patch
---

Store session archive metadata and archived session files under `PI_WEB_DATA_DIR` when configured, and automatically migrate a legacy archive on the first eligible session-daemon startup after upgrading.

Migration runs only when `PI_WEB_DATA_DIR` explicitly selects a different root, the legacy index and every referenced file form a complete valid archive, and the destination archive is pristine. PI WEB copies and verifies files across filesystem boundaries, rewrites their `archivePath` values, atomically commits the destination index, and only then removes legacy archive state. Ambiguous, invalid, partial, or coexisting layouts are left untouched instead of being merged or overwritten; active Pi session files are never moved.
