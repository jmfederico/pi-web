---
"@jmfederico/pi-web": major
---

Remove the public panel `routeAliases` and `navigationAliases` options and historical panel-link compatibility. Plugins still supplying these options fail registration; remove them and update saved URLs to current qualified contribution IDs and query namespaces. The bundled Files and Terminal IDs are `pi-web.files:workspace.files` and `pi-web.terminal:workspace.terminal`. Host-owned remote source/runtime identity mapping and action shortcut aliases are unchanged.
