import { message } from "../../localization/service";

export default {
  webWarning: message<{ target: string }>("Restart only the web/API service on {target} to apply saved gateway changes. Browsers will disconnect; sessions and terminals keep running. The address may change or stop being allowed.", "Direct gateway restart warning; target is the local gateway label, never the Settings machine"),
  sessiondWarning: message<{ target: string }>("Restart the session daemon on {target} to apply saved settings. This interrupts active sessions, running work, and terminals on that machine.", "Direct daemon restart warning; target is the Settings machine label"),
  web: message("Restart web/API", "Immediately launch a web-only restart without confirmation"),
  sessiond: message("Restart session daemon", "Immediately launch a daemon-only restart without confirmation"),
  starting: message("Starting restart…", "Restart launch callback is pending; not a completed service restart"),
  failure: message<{ error: string }>("Could not start restart: {error}", "Restart launch failure; error is a raw diagnostic"),
};
