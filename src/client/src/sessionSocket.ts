import { globalSessionEvents, sessionEvents } from "./api";
import type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes";

export type { GlobalSessionEvent, SessionUiEvent } from "../../shared/apiTypes";

export class SessionSocket {
  private socket: WebSocket | undefined;
  private sessionId: string | undefined;
  private onEvent: ((event: SessionUiEvent) => void) | undefined;
  private reconnectTimer?: number;
  private reconnectDelay = 500;
  private shouldReconnect = false;

  connect(sessionId: string, onEvent: (event: SessionUiEvent) => void): void {
    this.close();
    this.sessionId = sessionId;
    this.onEvent = onEvent;
    this.shouldReconnect = true;
    this.open();
  }

  setHandler(onEvent: (event: SessionUiEvent) => void): void {
    this.onEvent = onEvent;
  }

  close(): void {
    this.shouldReconnect = false;
    window.clearTimeout(this.reconnectTimer);
    closeSocketQuietly(this.socket);
    this.socket = undefined;
    this.sessionId = undefined;
    this.onEvent = undefined;
  }

  private open(): void {
    if (this.sessionId === undefined || this.sessionId === "" || !this.shouldReconnect) return;
    const socket = sessionEvents(this.sessionId);
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectDelay = 500;
    };
    socket.onmessage = (message) => void this.handleMessage(message.data);
    socket.onerror = () => { socket.close(); };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    window.clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 5000);
    this.reconnectTimer = window.setTimeout(() => { this.open(); }, delay);
  }

  private async handleMessage(data: MessageEvent["data"]): Promise<void> {
    const event = await parseSocketEvent(data);
    if (isSessionUiEvent(event)) this.onEvent?.(event);
  }
}

export class GlobalSessionSocket {
  private socket: WebSocket | undefined;
  private onEvent: ((event: GlobalSessionEvent) => void) | undefined;
  private reconnectTimer?: number;
  private reconnectDelay = 500;
  private shouldReconnect = false;

  connect(onEvent: (event: GlobalSessionEvent) => void): void {
    this.close();
    this.onEvent = onEvent;
    this.shouldReconnect = true;
    this.open();
  }

  close(): void {
    this.shouldReconnect = false;
    window.clearTimeout(this.reconnectTimer);
    closeSocketQuietly(this.socket);
    this.socket = undefined;
    this.onEvent = undefined;
  }

  private open(): void {
    if (!this.shouldReconnect) return;
    const socket = globalSessionEvents();
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectDelay = 500;
    };
    socket.onmessage = (message) => void this.handleMessage(message.data);
    socket.onerror = () => { socket.close(); };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    window.clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 5000);
    this.reconnectTimer = window.setTimeout(() => { this.open(); }, delay);
  }

  private async handleMessage(data: MessageEvent["data"]): Promise<void> {
    const event = await parseSocketEvent(data);
    if (isGlobalSessionEvent(event)) this.onEvent?.(event);
  }
}

function isSessionUiEvent(event: unknown): event is SessionUiEvent {
  const type = eventType(event);
  return ["assistant.delta", "tool.start", "tool.end", "shell.start", "shell.chunk", "shell.end", "agent.start", "agent.end", "message.end", "status.update", "activity.update", "command.output", "session.error", "session.name", "pi.event"].includes(type);
}

function isGlobalSessionEvent(event: unknown): event is GlobalSessionEvent {
  const type = eventType(event);
  return type === "status.update" || type === "activity.update" || type === "session.name";
}

function eventType(event: unknown): string {
  if (typeof event !== "object" || event === null || !("type" in event)) return "";
  const type = event.type;
  return typeof type === "string" ? type : "";
}

async function parseSocketEvent(data: MessageEvent["data"]): Promise<unknown> {
  try {
    if (typeof data === "string") return JSON.parse(data);
    if (data instanceof Blob) return JSON.parse(await data.text());
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
    return undefined;
  } catch {
    return undefined;
  }
}

function closeSocketQuietly(socket: WebSocket | undefined): void {
  if (socket === undefined) return;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onopen = () => { socket.close(); };
    return;
  }
  socket.close();
}
