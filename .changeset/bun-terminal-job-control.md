---
"@jmfederico/pi-web": patch
---

Fixes Bun terminals starting bash without job control: the web terminal printed
"bash: cannot set terminal process group … bash: no job control in this shell",
`^C` did not interrupt the foreground command, and a terminal could outlive the
daemon silently. `Bun.spawn({ terminal })` on a pre-created `Bun.Terminal` only
wired stdio — the shell kept the daemon's session and had no controlling
terminal (oven-sh/bun#33240). The Bun terminal backend now spawns the shell
detached, so it becomes a session leader and owns the PTY: job control works,
`^C` reaches the foreground process group, and closing the daemon delivers
SIGHUP through the PTY. Node.js terminals via `node-pty` are unchanged.
