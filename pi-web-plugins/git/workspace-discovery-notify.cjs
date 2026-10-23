// Packaged with PI WEB: best-effort discovery hint, never Git authority.
const { spawnSync } = require("node:child_process");
const [notification, ...args] = process.argv.slice(2);

// Initial worktree checkout has a null previous OID and branch flag 1.
// --no-checkout skips this hook; ordinary catalog access still discovers it.
if (args.length === 3 && /^(?:0{40}|0{64})$/.test(args[0]) && args[2] === "1") {
  try {
    const command = JSON.parse(notification);
    if (Array.isArray(command) && command.length > 0 && command.every((value) => typeof value === "string")) {
      spawnSync(command[0], command.slice(1), { stdio: "ignore", timeout: 2000, killSignal: "SIGKILL" });
    }
  } catch { /* Invalid arguments, missing commands, and daemon failures must not affect Git. */ }
}
