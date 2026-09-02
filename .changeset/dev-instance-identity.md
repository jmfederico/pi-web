---
"@jmfederico/pi-web": patch
---

Make the running instance identifiable at a glance where no browser chrome helps. In an installed PWA window, the header shows a machine control: a dropdown listing every machine with its own favicon (dimmed when offline) when a choice exists, or a static bubble with the instance favicon and gateway address when only the local machine exists; the mobile breadcrumb leads with a Machine chip carrying the same identity. In a regular browser tab the location indicators stay hidden and the machine control remains a pure selector. Development deployments (Docker dev mode or a source checkout) recolor the favicon and PWA icons purple and install the PWA as "PI WEB (dev)".
