// Shared only with the isolated diagnostic subprocess, never a configured value.
export const MCP_CHECK_OWNER_ENV = "PI_WEB_MCP_CHECK_OWNER";

/**
 * Fixed code for the isolated diagnostic CLI process, never interpolated config.
 * Preserve the host's ownership marker even when Pi supplies an explicit env.
 * Native wrappers inherit it too, so a detached helper remains identifiable after
 * its parent exits. The host owns cleanup; an exited wrapper's PID/group is not a
 * safe cleanup handle. Patching spawn is confined to this subprocess, not sessiond.
 */
export const MCP_CHECK_BOOTSTRAP = `
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const ownerKey = "${MCP_CHECK_OWNER_ENV}";
const spawn = cp.spawn;
const report = (message) => { if (process.connected) process.send(message); };
cp.spawn = (...args) => {
  const index = Array.isArray(args[1]) || args.length >= 3 ? 2 : 1;
  const options = args[index] ?? {};
  if (process.env[ownerKey]) {
    args[index] = {...options, env: {...(options.env ?? process.env), [ownerKey]: process.env[ownerKey]}};
  }
  const before = Date.now();
  const child = spawn(...args);
  if (process.platform === "win32" && child.pid !== undefined) {
    const pid = child.pid;
    report({type: "mcp.check.spawn", pid, before, after: Date.now()});
  }
  return child;
};
syncBuiltinESMExports();
process.once("SIGTERM", () => process.exit(143));
await import(pathToFileURL(process.argv[1]).href);
`;
