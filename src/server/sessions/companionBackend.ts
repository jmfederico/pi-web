import type { EventBus } from "../../piSdk.js";
import type { PluginBackend, PluginBackendScope, PluginPeer, PluginPeerChannel, PluginPeerChannelClose, PluginPeerChannelOptions } from "../../shared/pluginApiTypes.js";
import type { JsonValue } from "../../server-plugin-api.js";
import { cloneBoundedPluginBackendJson, PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES, PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES, PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES, PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS, PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES, serializePluginBackendChannelDataEnvelope, serializePluginBackendChannelReadyEnvelope } from "../../shared/pluginBackendProtocol.js";
import type { PluginBackendRegistry, PluginBackendRequest, PluginBackendChannelSession } from "../plugins/pluginBackendRegistry.js";
import type { ServerPluginPairedBackendContribution } from "../plugins/serverPluginRuntime.js";
import type { ProjectService } from "../projects/projectService.js";

export interface CompanionBackendBindingOptions {
  /** Healthy active contributions from the same snapshot as the registry. */
  backends: Pick<PluginBackendRegistry, "request" | "openChannel">;
  contributions: readonly ServerPluginPairedBackendContribution[];
  projects: Pick<ProjectService, "requireProject">;
}

/** One runtime bus owns these facades; detach revokes them without closing the bus. */
export function bindCompanionBackend(
  bus: EventBus,
  bindingOptions: CompanionBackendBindingOptions | (() => CompanionBackendBindingOptions),
): () => void {
  const lifetime = new AbortController();
  const unsubscribe = bus.on("pi-web:companion-backend:discover", (data: unknown) => {
    if (typeof data !== "object" || data === null) return;
    const pluginId: unknown = Reflect.get(data, "pluginId");
    const accept: unknown = Reflect.get(data, "accept");
    if (typeof accept !== "function") return;
    Reflect.apply(accept, undefined, [(): PluginBackend => {
      lifetime.signal.throwIfAborted();
      // Startup may register the bus before healthy registry authority is ready.
      const options = typeof bindingOptions === "function" ? bindingOptions() : bindingOptions;
      const contribution = options.contributions.find((candidate) => candidate.pluginId === pluginId);
      if (contribution?.apiVersion !== 5) throw new Error(`No active v5 companion backend for ${String(pluginId)}`);
      const { moduleRevision, backend } = contribution;
      const canRequest = typeof backend.request === "function";
      const canOpen = typeof backend.openChannel === "function";
      if (!canRequest && !canOpen) throw new Error("Companion backend has no operations");
      const identity = { pluginId: contribution.pluginId, moduleRevision };
      return Object.freeze({
        machineId: "local",
        forScope: (scope: PluginBackendScope): PluginPeer => {
          lifetime.signal.throwIfAborted();
          const selected = snapshotScope(scope);
          const request = async (operation: string, input: JsonValue): Promise<PluginBackendRequest> => {
            // Snapshot before host lookup can yield to the extension again.
            const detachedInput = cloneBoundedPluginBackendJson(input, "Companion backend input");
            const project = selected.kind === "machine" ? undefined : await options.projects.requireProject(selected.projectId);
            return { ...identity, scope: selected.kind, project, workspaceId: selected.kind === "workspace" ? selected.workspaceId : undefined, operation, input: detachedInput };
          };
          const peer = {
            ...(canRequest ? {
              request: async (operation: string, input: JsonValue, callOptions?: { readonly signal?: AbortSignal }) => {
                const call = linkedCall(lifetime.signal, callOptions?.signal);
                try {
                  return await call.wait(async () => {
                    const resolved = await request(operation, input);
                    call.signal.throwIfAborted();
                    return options.backends.request(resolved, call.signal);
                  });
                } finally { call.dispose(); }
              },
            } : {}),
            ...(canOpen ? {
              openChannel: async (operation: string, input: JsonValue, channelOptions: PluginPeerChannelOptions) => {
                const call = linkedCall(lifetime.signal, channelOptions.signal);
                try {
                  const resolved = await call.wait(() => request(operation, input));
                  call.signal.throwIfAborted();
                  return await openChannel(options.backends, resolved, channelOptions, call);
                } catch (error) { call.dispose(); throw error; }
              },
            } : {}),
          };
          if (peer.request !== undefined) return Object.freeze({ request: peer.request, ...(peer.openChannel === undefined ? {} : { openChannel: peer.openChannel }) });
          if (peer.openChannel !== undefined) return Object.freeze({ openChannel: peer.openChannel });
          throw new Error("Companion backend has no operations");
        },
      });
    }]);
  });
  return () => {
    unsubscribe();
    lifetime.abort(new Error("Companion backend runtime detached"));
  };
}

function snapshotScope(scope: PluginBackendScope): PluginBackendScope {
  if (scope.kind === "machine") return Object.freeze({ kind: "machine" });
  if (!["project", "workspace"].includes(scope.kind)) throw new Error("Invalid companion backend scope");
  requireId(scope.projectId);
  if (scope.kind === "project") return Object.freeze({ kind: "project", projectId: scope.projectId });
  requireId(scope.workspaceId);
  return Object.freeze({ kind: "workspace", projectId: scope.projectId, workspaceId: scope.workspaceId });
}

function requireId(id: string): void {
  if (typeof id !== "string" || id.trim() === "" || id.length > 512) throw new Error("Invalid companion backend scope id");
}

function linkedCall(lifetime: AbortSignal, caller?: AbortSignal) {
  const controller = new AbortController();
  const abortLifetime = () => { controller.abort(lifetime.reason); };
  const abortCaller = () => { controller.abort(caller?.reason); };
  if (lifetime.aborted) abortLifetime();
  else lifetime.addEventListener("abort", abortLifetime, { once: true });
  if (caller?.aborted === true) abortCaller();
  else caller?.addEventListener("abort", abortCaller, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      lifetime.removeEventListener("abort", abortLifetime);
      caller?.removeEventListener("abort", abortCaller);
    },
    wait: async <T>(work: () => Promise<T>): Promise<T> => {
      controller.signal.throwIfAborted();
      let abort = () => { controller.signal.throwIfAborted(); };
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => { reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Companion backend call cancelled")); };
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      try { return await Promise.race([work(), cancelled]); }
      finally { controller.signal.removeEventListener("abort", abort); }
    },
  };
}

type Call = ReturnType<typeof linkedCall>;

async function drainFrames(queued: Promise<void>, call: Call): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await call.wait(() => Promise.race([queued, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error("Companion channel receive drain timed out")); }, PLUGIN_BACKEND_CHANNEL_DRAIN_TIMEOUT_MS);
      timer.unref();
    })]));
  } finally { clearTimeout(timer); }
}

async function openChannel(
  backends: CompanionBackendBindingOptions["backends"],
  request: PluginBackendRequest,
  options: PluginPeerChannelOptions,
  call: Call,
): Promise<PluginPeerChannel> {
  let session: PluginBackendChannelSession | undefined;
  let result: PluginPeerChannelClose | undefined;
  let closing = false;
  let draining = false;
  let ready = false;
  const openingFrames: JsonValue[] = [];
  let openingBytes = 0;
  const discardOpeningFrames = () => { openingFrames.length = 0; openingBytes = 0; };
  let queued = Promise.resolve();
  let error: PluginPeerChannelClose["error"];
  let resolveClosed!: (close: PluginPeerChannelClose) => void;
  const closed = new Promise<PluginPeerChannelClose>((resolve) => { resolveClosed = resolve; });
  const finish = (code: number, reason: string) => {
    if (result !== undefined) return;
    discardOpeningFrames();
    result = Object.freeze({ code, reason, wasClean: code === 1000 && error === undefined, ...(error === undefined ? {} : { error }) });
    call.signal.removeEventListener("abort", abort);
    call.dispose();
    resolveClosed(result);
  };
  const close = (code: number, reason: string) => {
    if (closing || result !== undefined) return;
    closing = true;
    draining = code === 1000;
    if (session === undefined) { finish(code, reason); return; }
    // Match transport close semantics: a clean close boundedly drains accepted frames.
    void (async () => {
      let closeCode = code, closeReason = reason;
      if (draining) {
        try { await drainFrames(queued, call); }
        catch (failure) {
          draining = false;
          error ??= Object.freeze({ code: "drain-failed", message: String(failure) });
          closeCode = 1011;
          closeReason = "Companion channel receive drain failed";
        }
      }
      await session.close(closeCode, closeReason);
      finish(closeCode, closeReason);
    })().catch((failure: unknown) => {
      error ??= Object.freeze({ code: "close-failed", message: String(failure) });
      finish(1011, "Companion channel cleanup failed");
    });
  };
  const abort = () => { close(1001, "Companion backend call cancelled"); };
  call.signal.addEventListener("abort", abort, { once: true });
  try {
    await call.wait(async () => {
      session = await backends.openChannel(request, {
        send: (data) => {
          if ((closing && !draining) || result !== undefined) throw new Error("Companion channel is closed");
          if (ready) { options.onData(data); return; }
          // Match the browser writer: reserve room for ready and bound serialized frames.
          const bytes = Buffer.byteLength(serializePluginBackendChannelDataEnvelope(data), "utf8");
          const readyBytes = Buffer.byteLength(serializePluginBackendChannelReadyEnvelope(), "utf8");
          if (openingFrames.length >= PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES - 1
            || openingBytes + bytes + readyBytes > PLUGIN_BACKEND_CHANNEL_SERVER_TO_BROWSER_QUEUE_MAX_BYTES) {
            throw new Error("Companion channel plugin queue limit was exceeded");
          }
          openingFrames.push(data);
          openingBytes += bytes;
        },
        sendError: (code, message) => { discardOpeningFrames(); error ??= Object.freeze({ code, message }); },
        close: finish,
      }, call.signal);
      if (result !== undefined || call.signal.aborted) {
        await session.close(1001, "Companion channel closed during open");
        throw new Error("Companion channel closed during open");
      }
    });
  } catch (failure) {
    finish(1011, "Companion channel open failed");
    throw failure;
  }
  if (session === undefined) throw new Error("Companion channel did not open");
  const opened = session;
  ready = true;
  const isClosed = () => closing || result !== undefined || call.signal.aborted;
  try {
    for (const frame of openingFrames) {
      if (isClosed()) break;
      options.onData(frame);
    }
  } catch (failure) {
    // Once ready, consumer failures close the channel rather than fail its open.
    error ??= Object.freeze({ code: "protocol-error", message: failure instanceof Error ? failure.message : String(failure) });
    close(1000, "Channel protocol error");
  } finally { discardOpeningFrames(); }
  let pending = 0;
  let pendingBytes = 0;
  return Object.freeze({
    closed,
    send: (data: JsonValue) => {
      if (closing || result !== undefined || call.signal.aborted) throw new Error("Companion channel is closed");
      if (pending >= PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_FRAMES) {
        close(1008, "Companion channel receive queue is full");
        throw new Error("Companion channel receive queue is full");
      }
      let frame: JsonValue;
      try {
        frame = cloneBoundedPluginBackendJson(data, "Companion channel frame", PLUGIN_BACKEND_CHANNEL_DATA_JSON_MAX_BYTES);
      } catch (failure) {
        close(1008, "Invalid companion channel frame");
        throw failure;
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
      if (pendingBytes + bytes > PLUGIN_BACKEND_CHANNEL_QUEUE_MAX_BYTES) {
        close(1008, "Companion channel receive queue is full");
        throw new Error("Companion channel receive queue is full");
      }
      pending += 1;
      pendingBytes += bytes;
      queued = queued.then(async () => {
        if ((!closing || draining) && result === undefined && !call.signal.aborted) await opened.receive(frame);
      }).catch((failure: unknown) => {
        error ??= Object.freeze({ code: "receive-failed", message: String(failure) });
        close(1011, "Companion channel receive failed");
      }).finally(() => { pending -= 1; pendingBytes -= bytes; });
    },
    close: (reason?: string) => { close(1000, reason ?? "Companion channel closed"); },
  });
}
