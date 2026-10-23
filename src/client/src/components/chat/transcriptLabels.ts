/** The message-header label used when a tool message renders as an image output. */
export function chatToolOutputLabel(toolName?: string): string {
  return toolName === undefined || toolName === "" ? "tool output" : `${toolName} output`;
}

export function chatMessageGroupClassName(defaultOpen: boolean): string {
  return defaultOpen ? "msg event-group live" : "msg event-group";
}

export function chatMessageGroupLabel(defaultOpen: boolean): string {
  return defaultOpen ? "live events" : "events";
}
