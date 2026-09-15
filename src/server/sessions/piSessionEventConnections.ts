import type { createEventBus } from "@earendil-works/pi-coding-agent";
import type { PiWebHostPiSessionConnection } from "../../server-plugin-api.js";

type EventBus = ReturnType<typeof createEventBus>;

/** Buses belong to concrete native sessions, never to a cwd or a reusable id. */
export class PiSessionEventConnections {
  private readonly sessions = new WeakMap<object, { bus: EventBus; connections: Set<PiWebHostPiSessionConnection> }>();

  register(session: object, bus: EventBus): void {
    this.close(session);
    this.sessions.set(session, { bus, connections: new Set() });
  }

  connect(session: object, lifetime: AbortSignal): PiWebHostPiSessionConnection {
    lifetime.throwIfAborted();
    const hosted = this.sessions.get(session);
    if (hosted === undefined) throw new Error("Hosted session does not have a package event bus");
    const controller = new AbortController();
    const subscriptions = new Set<() => void>();
    const close = (): void => {
      if (controller.signal.aborted) return;
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      hosted.connections.delete(connection);
      lifetime.removeEventListener("abort", close);
      controller.abort(new Error("PI session events connection closed"));
    };
    const assertChannel = (channel: string): void => {
      controller.signal.throwIfAborted();
      if (typeof channel !== "string" || channel.trim() === "") throw new Error("PI event channel must be non-empty");
    };
    const connection: PiWebHostPiSessionConnection = Object.freeze({
      signal: controller.signal,
      on: (channel: string, handler: (data: unknown) => void | Promise<void>): (() => void) => {
        assertChannel(channel);
        if (typeof handler !== "function") throw new Error("PI event handler must be a function");
        // Native Pi awaits/catches handler results despite its void callback type.
        // Return async work to that error boundary instead of dropping rejections.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        const detach = hosted.bus.on(channel, (data) => {
          if (!controller.signal.aborted) return handler(data);
        });
        const unsubscribe = (): void => { detach(); subscriptions.delete(unsubscribe); };
        subscriptions.add(unsubscribe);
        return unsubscribe;
      },
      emit: (channel: string, data: unknown): void => { assertChannel(channel); hosted.bus.emit(channel, data); },
      close,
    });
    hosted.connections.add(connection);
    lifetime.addEventListener("abort", close, { once: true });
    return connection;
  }

  close(session: object): void {
    const hosted = this.sessions.get(session);
    if (hosted === undefined) return;
    for (const connection of hosted.connections) connection.close();
    this.sessions.delete(session);
  }
}
