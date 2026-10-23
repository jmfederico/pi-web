export type SocketPayloadLimiter = (socket: object, maxBytes: number) => void;

/**
 * Node's ws receiver can tighten limits while assembling a message. Bun's
 * native compatibility transport has no receiver control; shared channel
 * decoders still enforce the application bounds after message delivery.
 */
export function createSocketPayloadLimiter(nativeTransport: boolean): SocketPayloadLimiter {
  return (socket, maxBytes) => {
    const receiver: unknown = Reflect.get(socket, "_receiver");
    if (nativeTransport && receiver === undefined) return;
    if (typeof receiver !== "object" || receiver === null || typeof Reflect.get(receiver, "_maxPayload") !== "number"
      || !Reflect.set(receiver, "_maxPayload", maxBytes)) {
      throw new Error("Plugin backend channel transport cannot apply its payload limit");
    }
  };
}
