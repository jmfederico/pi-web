const SESSION_NAME_MAX_LENGTH = 60;
/** Explicit extension names are validated, not silently rewritten. */
export function requireInitialSessionName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()
    // eslint-disable-next-line no-control-regex -- explicit names must not contain control characters.
    || value.length > SESSION_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Initial session name must be trimmed, non-empty, at most 60 characters, and contain no control characters");
  }
  return value;
}
