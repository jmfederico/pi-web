---
"@jmfederico/pi-web": patch
---

Require Safe Tunnel providers to use a DNS relay over secure WebSocket on port 443. PI WEB now preserves WSS while supplying its own relay trust and local target, and fails closed instead of accepting omitted or downgraded protocols, alternate ports, provider-selected trust, or extra routes.
