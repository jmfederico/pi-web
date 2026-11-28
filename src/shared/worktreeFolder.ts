/** Validate the path spelling without interpreting another machine's path syntax. */
export function requireWorktreeFolder(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${source} must be a non-empty path`);
  }
  return value.trim();
}
