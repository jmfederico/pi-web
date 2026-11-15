import { randomUUID } from "node:crypto";
import type {
  JsonValue, PiWebHostPiSessionEventsV1, PiWebHostPiSessionSelection,
  PluginSessionStateV1, ServerPluginPeerRequestContextV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { createPrivateFile, type WriteOutcome } from "./destination.js";
import {
  boundedText, CHECK_EVENT, isFinished, MAX_SECRET_BYTES, NOTIFY_EVENT,
  parseRecord, recordObject, REPLY_EVENT, requestId, stateNamespace, type PrivateInputRecord,
} from "./protocol.js";

type Writer = (destination: string, secret: string, signal: AbortSignal) => Promise<WriteOutcome>;

/** Owns admission and non-secret durable outcomes. Secret values never enter state or events. */
export class PrivateInputService {
  private readonly active = new Set<string>();
  constructor(
    private readonly state: PluginSessionStateV1,
    private readonly events: PiWebHostPiSessionEventsV1,
    private readonly lifetime: AbortSignal,
    private readonly writeFile: Writer = createPrivateFile,
  ) {}

  async request({ scope, operation, input, signal }: ServerPluginPeerRequestContextV5): Promise<JsonValue> {
    try {
      this.lifetime.throwIfAborted();
      signal.throwIfAborted();
      if (operation === "available") return { available: true };
      if (scope.kind !== "workspace") throw new Error("Workspace required");
      const data = recordObject(input);
      const id = requestId(data["requestId"]);
      const target = { projectId: scope.project.id, workspaceId: scope.workspace.id, sessionId: boundedText(data["sessionId"], 512) };
      if (!["status", "submit", "cancel", "notify"].includes(operation)) throw new Error("Unknown operation");
      const namespace = stateNamespace(id);
      const snapshot = await this.state.read(target, namespace, { signal });
      const record = parseRecord(snapshot.value);
      if (record.requestId !== id || record.sessionId !== target.sessionId) throw new Error("Request not owned by session");
      const key = `${target.sessionId}:${id}`;
      if (operation === "status") return { record: { ...record }, active: this.active.has(key) };
      if (this.active.has(key)) return { record: { ...record }, active: true };
      this.active.add(key);
      try {
        // A previous daemon may have stopped between file creation and outcome
        // persistence. Never infer success from existence or rewrite that file.
        if (record.status === "writing") {
          const uncertain: PrivateInputRecord = { ...record, status: "failed", failure: "write_uncertain" };
          await this.state.write(target, namespace, { revision: snapshot.revision, inherit: false, value: { ...uncertain } }, { signal });
          return await this.notify(target, uncertain, signal);
        }
        if (isFinished(record)) return await this.notify(target, record, signal);
        if (operation === "notify") return { record: { ...record }, delivered: false };
        if (operation === "submit") {
          if (data["confirmedDestination"] !== record.destination || typeof data["secret"] !== "string"
            || data["secret"].length === 0 || Buffer.byteLength(data["secret"], "utf8") > MAX_SECRET_BYTES) {
            throw new Error("Invalid submission");
          }
        }
        if (!await this.exchange(target, id, CHECK_EVENT, signal)) return { record: { ...record }, unavailable: true };
        signal.throwIfAborted();
        this.lifetime.throwIfAborted();
        const claimed = await this.state.write(target, namespace, {
          revision: snapshot.revision, inherit: false, value: { ...record, status: "writing" },
        }, { signal });
        // Once admitted, a browser disconnect must not discard a completed write
        // or its outcome. Only plugin shutdown cancels this bounded local work.
        let outcome: WriteOutcome | { status: "cancelled" };
        if (operation === "cancel") outcome = { status: "cancelled" };
        else {
          try {
            const secret = data["secret"];
            if (typeof secret !== "string") throw new Error("Invalid submission");
            outcome = await this.writeFile(record.destination, secret, this.lifetime);
          } catch { outcome = { status: "failed", failure: "write_uncertain" }; }
        }
        const finished: PrivateInputRecord = { ...record, ...outcome };
        await this.state.write(target, namespace, { revision: claimed.revision, inherit: false, value: { ...finished } }, { signal: this.lifetime });
        return await this.notify(target, finished, this.lifetime);
      } finally { this.active.delete(key); }
    } catch {
      // This is a privacy boundary, including malformed inputs and host failures.
      // Callers recover via status, never by replaying a secret submission.
      throw new Error("Private input operation could not be confirmed. Refresh its status before trying again.");
    }
  }

  private async notify(target: PiWebHostPiSessionSelection, record: PrivateInputRecord, signal: AbortSignal): Promise<JsonValue> {
    let delivered = false;
    try { delivered = await this.exchange(target, record.requestId, NOTIFY_EVENT, signal); }
    catch { /* The durable outcome remains available for an explicit notification retry. */ }
    return { record: { ...record }, delivered };
  }

  private async exchange(target: PiWebHostPiSessionSelection, id: string, channel: string, signal: AbortSignal): Promise<boolean> {
    const connection = await this.events.connect(target);
    const nonce = randomUUID();
    try {
      return await new Promise<boolean>((resolve) => {
        const end = (accepted: boolean) => { clearTimeout(timer); off(); combined.removeEventListener("abort", abort); resolve(accepted); };
        const combined = AbortSignal.any([signal, this.lifetime, connection.signal]);
        const abort = () => { end(false); };
        const off = connection.on(REPLY_EVENT, (value) => {
          if (typeof value === "object" && value !== null && "nonce" in value && value.nonce === nonce && "accepted" in value) {
            end(value.accepted === true);
          }
        });
        const timer = setTimeout(() => { end(false); }, 3000);
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) { end(false); return; }
        try { connection.emit(channel, { requestId: id, nonce }); }
        catch { end(false); }
      });
    } finally { connection.close(); }
  }
}
