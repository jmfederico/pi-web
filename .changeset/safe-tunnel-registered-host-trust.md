---
"@jmfederico/pi-web": patch
---

Trust saved Safe Tunnel ingress without manual host configuration. Browser API reads and mutations trust the exact registered public hostname, while the split Vite development server loads the exact saved public hostname into HTTP and proxied application-WebSocket host checks at startup. After first registration or a hostname change/removal, restart Vite manually; browser refresh alone does not update host trust. Settings shows that hostname as managed read-only state instead of writing it to `allowedHosts`; unconfigured sibling and unrelated hostnames remain denied.
