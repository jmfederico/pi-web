---
"@jmfederico/pi-web": patch
---

Add best-effort Bun support for the installed application, including native terminals and runtime-aware service launchers that use POSIX `sh` instead of Bash. Set `PI_WEB_RUNTIME=bun` to opt in; auto selection still prefers Node.js. Existing service definitions need `pi-web install` again to adopt the launchers. Doctor and version reports identify each process's actual runtime. Doctor distinguishes startup prerequisites from the running Terminal plugin's state, including intentional recovery disablement.

Keep Node terminal behavior behind the same provider contract, make `node-pty` optional at installation, and finalize command runs when their terminals are closed. Bun terminals do not require the native addon. Node.js remains the recommended production runtime; native Pi extensions may not be compatible with Bun.
