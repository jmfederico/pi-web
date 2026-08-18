/**
 * Path comparison for session and workspace paths inside the browser.
 *
 * These paths are absolute and produced by the server, but not by a single code
 * path: a listed session's `path` comes from Pi's session store enumeration,
 * while the `parentSessionPath` on a `session.created` broadcast comes from the
 * live runtime's session file. Comparing them with `===` therefore depends on
 * two independent producers agreeing on trailing separators, which is exactly
 * the kind of coincidence that breaks silently.
 *
 * Node's `path` module is not available here, so this normalizes the only
 * difference that can realistically appear between two server-produced absolute
 * paths: trailing separators. It deliberately does not resolve `.`/`..` or
 * symlinks, which the server already handles before values reach the browser.
 */
export function normalizeSessionPath(path: string): string {
  return path.replace(/[/\\]+$/u, "");
}
