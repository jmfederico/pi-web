import { randomUUID } from "node:crypto";
import { PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY } from "@jmfederico/pi-web/server-plugin-api";
import type { PiWebHostPiSessionsV1, PiWebHostPiSessionEventsV1, PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";
import { type LogEntry } from "./browser/protocol.js";
import { LOG_CHANNEL, entryFrames, isCaptainClientFrame, type CaptainServerFrame } from "./browser/channelProtocol.js";
import { collectReply, collectSourceReply } from "./roundtrip.js";
import { LogStore, logScope } from "./store.js";

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "Captain's Log",
  requires: [PI_WEB_HOST_PI_SESSIONS_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
  activate(host) {
    const store = new LogStore(host.dataDirectory);
    const active = new Map<string, LogEntry>();
    const unsaved = new Map<string, LogEntry>();
    const currentSessions = new Map<string, string>();
    const subscribers = new Map<string, Set<(frame: CaptainServerFrame) => void>>();
    const channelCleanups = new Set<() => void>();
    function publish(scope: string, entry: LogEntry, saved: boolean) {
      for (const frame of entryFrames(entry, saved)) for (const send of subscribers.get(scope) ?? []) send(frame);
    }
    const tasks = new Set<Promise<void>>();
    let sessions: PiWebHostPiSessionsV1;
    let events: PiWebHostPiSessionEventsV1;
    function visible(scope: string, entry: LogEntry): LogEntry {
      const live = active.get(scope);
      if (live?.id === entry.id) return live;
      return unsaved.get(entry.id) ?? (entry.status === "running"
        ? { ...entry, status: "interrupted", failureCode: "interrupted", text: "Captain's Log stopped before recording completion. Inspect the previous session before retrying. Nothing was resent automatically." }
        : entry);
    }
    return {
      start({ capabilities }) {
        sessions = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
        events = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
      },
      peer: {
        async request(context) {
          context.signal.throwIfAborted();
          host.lifetimeSignal.throwIfAborted();
          const selection = { projectId: context.project.id, workspaceId: context.workspace.id };
          const scope = logScope(selection.projectId, selection.workspaceId);
          if (context.operation === "list") {
            const entries = (await store.list(scope)).map((entry) => visible(scope, entry));
            const live = active.get(scope);
            if (live && !entries.some((entry) => entry.id === live.id)) entries.unshift(live);
            return entries.map((entry) => ({ ...entry, text: "" }));
          }
          if (context.operation === "read") {
            const live = active.get(scope);
            return { ...(live?.id === context.input ? live : visible(scope, await store.read(scope, context.input))) };
          }
          throw new Error("Unknown Captain operation (translations require the log channel)");
        },
        openChannel(context) {
          context.signal.throwIfAborted();
          host.lifetimeSignal.throwIfAborted();
          if (context.operation !== LOG_CHANNEL || context.input !== null) throw new Error("Invalid Captain channel open");
          const selection = { projectId: context.project.id, workspaceId: context.workspace.id };
          const scope = logScope(selection.projectId, selection.workspaceId);
          let listening = true;
          const send = (frame: CaptainServerFrame) => {
            if (!listening) return;
            try { context.send(frame.type === "entry" ? { ...frame, entry: { ...frame.entry } } : frame); }
            catch (error) { cleanup(); host.logger.warn(`Captain subscriber disconnected: ${String(error)}`); }
          };
          const cleanup = () => {
            listening = false;
            subscribers.get(scope)?.delete(send);
            if ((subscribers.get(scope)?.size ?? 0) === 0) subscribers.delete(scope);
            context.signal.removeEventListener("abort", cleanup);
            host.lifetimeSignal.removeEventListener("abort", cleanup);
            channelCleanups.delete(cleanup);
          };
          if (!subscribers.has(scope)) subscribers.set(scope, new Set());
          subscribers.get(scope)?.add(send);
          context.signal.addEventListener("abort", cleanup, { once: true });
          host.lifetimeSignal.addEventListener("abort", cleanup, { once: true });
          channelCleanups.add(cleanup);
          return {
            close: cleanup,
            async receive(data, signal) {
              signal.throwIfAborted();
              host.lifetimeSignal.throwIfAborted();
              if (!isCaptainClientFrame(data)) throw new Error("Invalid Captain translation frame");
              const reject = (message: string) => { send({ type: "rejected", requestId: data.requestId, message: message.slice(0, 2000) }); };
              if (active.has(scope)) { reject("Captain is already working."); return; }
              const entry: LogEntry = { id: randomUUID(), createdAt: new Date().toISOString(), sessionId: "", question: "Translate last reply", sourceSessionId: data.sourceSessionId, status: "running", stages: ["Backend admitted translation"], text: "Preparing Captain's Log…" };
              // Lock before any I/O so concurrent tabs cannot create two dedicated sessions.
              active.set(scope, entry);
              try {
                const previous = await store.list(scope);
                // Strictly increasing admission times make persisted session selection independent of UUID ties.
                const latestTime = Math.max(0, ...previous.map((record) => Date.parse(record.createdAt)).filter(Number.isFinite));
                entry.createdAt = new Date(Math.max(Date.now(), latestTime + 1)).toISOString();
                entry.sessionId = currentSessions.get(scope) ?? previous.find((record) => record.sessionId)?.sessionId ?? "";
                if (entry.sessionId === data.sourceSessionId || previous.some((record) => record.sessionId === data.sourceSessionId)) throw new Error("Select a source session other than the pirate conversation.");
                await store.save(scope, entry);
              } catch (error) { active.delete(scope); reject(String(error)); return; }
              send({ type: "admitted", requestId: data.requestId, id: entry.id });
              publish(scope, entry, true);
              const progress = (stage: string) => {
                if (!entry.stages.includes(stage) && entry.stages.length < 16) entry.stages.push(stage);
                publish(scope, entry, false);
              };
              const task = (async () => {
                try {
                  host.lifetimeSignal.throwIfAborted();
                  const source = await events.connect({ ...selection, sessionId: data.sourceSessionId });
                  let sourceText: string;
                  try { sourceText = await collectSourceReply(source, entry.id, host.lifetimeSignal, progress); }
                  finally { source.close(); }
                  progress("Source reply read without changing source");
                  const createPirate = async () => {
                    ({ sessionId: entry.sessionId } = await sessions.create(selection));
                    currentSessions.set(scope, entry.sessionId);
                    // Persist identity before any potentially ambiguous send.
                    await store.save(scope, entry);
                    return events.connect({ ...selection, sessionId: entry.sessionId });
                  };
                  const previousSessionId = entry.sessionId;
                  const connection = previousSessionId
                    ? await events.connect({ ...selection, sessionId: previousSessionId }).catch((error: unknown) => {
                      // Only a definitive rejection before sending permits automatic replacement.
                      if (error instanceof Error && error.message === "Selected session is not hosted in this workspace on this machine") return createPirate();
                      throw error;
                    })
                    : await createPirate();
                  progress("Pirate conversation selected");
                  try {
                    entry.text = await collectReply(connection, entry.id, sourceText, host.lifetimeSignal, progress);
                  } finally { connection.close(); }
                  entry.status = "completed";
                } catch (error) {
                  entry.status = "failed";
                  entry.failureCode ??= "request-failed";
                  entry.text = `Captain could not finish this request. Inspect the session before retrying; nothing was resent automatically.\n${error instanceof Error ? error.message : String(error)}`.slice(0, 4000);
                  progress("Backend recorded failure (not success)");
                }
                let saved = false;
                try {
                  if (entry.status === "completed") entry.stages.push("Backend saved completed roundtrip");
                  await store.save(scope, entry);
                  saved = true;
                }
                catch (error) {
                  entry.status = "failed";
                  entry.failureCode = "request-failed";
                  entry.stages = entry.stages.filter((stage) => stage !== "Backend saved completed roundtrip");
                  entry.text = `Could not save Captain's Log: ${String(error)}. Inspect session ${entry.sessionId}.`.slice(0, 4000);
                  unsaved.set(entry.id, { ...entry });
                  host.logger.error(entry.text);
                } finally { active.delete(scope); publish(scope, entry, saved); }
              })();
              tasks.add(task);
              void task.finally(() => { tasks.delete(task); });
            },
          };
        },
      },
      async dispose() {
        await Promise.all(tasks);
        for (const cleanup of channelCleanups) cleanup();
        active.clear(); unsaved.clear(); currentSessions.clear();
      },
    };
  },
};
export default plugin;
