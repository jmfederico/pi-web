---
"@jmfederico/pi-web": patch
---

Tolerate package-owned global systemd drop-ins when inspecting managed services, so `pi-web install`, `start`, and `doctor` work on stock Fedora and Bluefin (whose `service.d/10-timeout-abort.conf` applies to every user service). Overrides that alter the managed environment still fail closed.
