import { join } from "node:path";
import {
  PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY,
  type JsonValue, type PiWebServerPluginV5, type ServerPluginActivationContextV5,
  type ServerPluginStartContext, type ServerPluginPeerRequestContextV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { TaskScheduler, DispatchRejected } from "./scheduler.js";
import { configuredTimezone, dispatchPrompt, TaskService } from "./service.js";
import { TaskStore } from "./store.js";

const plugin: PiWebServerPluginV5 = {
  apiVersion: 5,
  name: "Scheduled agent tasks",
  requires: [PI_WEB_HOST_WORKSPACES_CAPABILITY, PI_WEB_HOST_PI_SESSIONS_CAPABILITY],
  activate(context) { return activateTasks(context); },
};
export default plugin;

/** Activation owns SQLite and scheduling; disposal never touches published conversations. */
export function activateTasks(context: ServerPluginActivationContextV5, now: () => string = () => new Date().toISOString()) {
  const defaultTimezone = configuredTimezone(context.settings["defaultTimezone"]);
  let store: TaskStore | undefined;
  let scheduler: TaskScheduler | undefined;
  let service: TaskService | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const logError = (error: unknown) => {
    context.logger.error("Scheduled tasks operation failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  };
  const quiesce = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    scheduler?.stop();
  };
  context.lifetimeSignal.addEventListener("abort", quiesce, { once: true });
  return {
    start({ capabilities }: ServerPluginStartContext) {
      context.lifetimeSignal.throwIfAborted();
      const workspaces = capabilities.resolve(PI_WEB_HOST_WORKSPACES_CAPABILITY);
      const sessions = capabilities.resolve(PI_WEB_HOST_PI_SESSIONS_CAPABILITY);
      const validateTarget = async (task: { projectId: string; workspaceId: string }) => {
        context.lifetimeSignal.throwIfAborted();
        await workspaces.resolve({ projectId: task.projectId, workspaceId: task.workspaceId });
        context.lifetimeSignal.throwIfAborted();
      };
      store = TaskStore.open(join(context.dataDirectory, "tasks.sqlite"));
      store.recover(now());
      scheduler = new TaskScheduler(store, {
        async dispatch(execution) {
          let prompt: string;
          try {
            await validateTarget(execution.task);
            prompt = dispatchPrompt(execution);
            if (Buffer.byteLength(prompt) > 64 * 1024) throw new Error("Dispatch prompt exceeds host limit");
          } catch (error) {
            throw new DispatchRejected(error instanceof Error ? error.message : String(error));
          }
          // After entering run(), failure can be ambiguous: never automatically resend.
          const run = await sessions.run({ projectId: execution.task.projectId, workspaceId: execution.task.workspaceId, prompt });
          // Initial-turn completion is deliberately NOT an execution outcome.
          void run.completion.catch(logError);
          return { sessionId: run.sessionId };
        },
      }, now, logError);
      service = new TaskService(store, scheduler, validateTarget, defaultTimezone, now);
      const tick = () => {
        try { scheduler?.tick(); } catch (error) { logError(error); }
      };
      timer = setInterval(tick, 1000);
      timer.unref();
      tick();
    },
    peer: {
      async request({ scope, operation, input, signal }: ServerPluginPeerRequestContextV5): Promise<JsonValue> {
        signal.throwIfAborted();
        context.lifetimeSignal.throwIfAborted();
        if (scope.kind !== "machine") throw new Error("Scheduled tasks requires machine scope");
        if (service === undefined) throw new Error("Scheduled tasks has not started");
        const result = await service.request(operation, input);
        // Domain records contain JSON only; detach them at the transport boundary.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Plugin-owned domain output, not external input.
        return JSON.parse(JSON.stringify(result)) as JsonValue;
      },
    },
    async dispose() {
      quiesce();
      context.lifetimeSignal.removeEventListener("abort", quiesce);
      await scheduler?.drain();
      store?.close();
      store = undefined;
      service = undefined;
    },
  };
}
