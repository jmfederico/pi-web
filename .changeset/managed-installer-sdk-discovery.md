---
"@jmfederico/pi-web": patch
---

Support Pi installed with the managed installer (`pi.dev/install.sh`). PI WEB now finds that Pi's SDK from the `pi` command on `PATH`. Services installed with `/pi-web install` from a managed Pi keep working after `pi update`, because they follow the install's current version instead of one release. Installation preflight verifies any explicit Pi selection retained for services and reports specific failures before changing configuration or services. Services installed earlier from a managed Pi need `/pi-web install` again.
