export const CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH = 512;

const TRUNCATION_MARKER = "...";

export function clientSessionFirstMessagePreview(value: string): string {
  if (value.length <= CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH) return value;

  const rawEnd = CLIENT_SESSION_FIRST_MESSAGE_MAX_LENGTH - TRUNCATION_MARKER.length;
  const end = endsAfterHighSurrogate(value, rawEnd) ? rawEnd - 1 : rawEnd;
  return `${value.slice(0, end)}${TRUNCATION_MARKER}`;
}

function endsAfterHighSurrogate(value: string, end: number): boolean {
  const code = value.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff;
}
