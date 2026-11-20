---
"@jmfederico/pi-web": patch
---
Keep PI WEB responsive while a large session daemon runs Git and other plugin commands. Commands now start from a small helper process, so selecting a project no longer pauses every other request for one to three seconds when the daemon holds many long sessions.
