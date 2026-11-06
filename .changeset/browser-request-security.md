---
"@jmfederico/pi-web": patch
---

Add an explicit host-validation decision without locking custom DNS deployments out of the production/default API on upgrade. New and existing installs default to `hostValidation: "pending"`: hostname enforcement is off with a persistent entry in the existing Notices panel, including when no workspace or session is selected. Its action opens General settings directly at the Host validation control. Choose `enabled` with an `allowedHosts` list to enforce it, or `disabled` to leave it off explicitly and dismiss the warning. Pending and disabled modes lack application-level DNS-rebinding protection. `enabled` with `allowedHosts: true` is invalid; Vite's existing development host policy remains independent.

Reject malformed Host headers in every mode, and keep the Origin guard active for WebSocket upgrades and HTTP methods other than GET, HEAD, and OPTIONS. Requests without Origin remain supported for CLI and Fleet clients. These checks are not authentication. Reverse proxies must preserve public Host (including nonstandard ports) and browser Origin unchanged, authenticate HTTP and WebSocket traffic, and restrict direct backend access and unrecognized public hosts.

`PI_WEB_HOST_VALIDATION` overrides gateway config. Restart web/API after changing `hostValidation` or `allowedHosts`; the UI flags pending enforcement changes requiring restart, but does not detect allowed-hosts-only changes. Choosing `disabled` while enforcement is already off clears the decision warning immediately. Also restart Vite after changing its allowed hosts. No session-daemon restart is needed for this change.
