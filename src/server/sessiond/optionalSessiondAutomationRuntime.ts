import type {
  SessiondAutomationRuntime,
  SessiondAutomationRuntimeDependencies,
} from "./sessiondAutomationRuntime.js";

export interface SessiondAutomationRuntimeModule {
  createSessiondAutomationRuntime(deps: SessiondAutomationRuntimeDependencies): SessiondAutomationRuntime;
}

export type SessiondAutomationRuntimeLoader = () => Promise<SessiondAutomationRuntimeModule>;

export async function loadOptionalSessiondAutomationRuntime(
  enabled: boolean,
  deps: SessiondAutomationRuntimeDependencies,
  load: SessiondAutomationRuntimeLoader = () => import("./sessiondAutomationRuntime.js"),
): Promise<SessiondAutomationRuntime | undefined> {
  if (!enabled) return undefined;
  return (await load()).createSessiondAutomationRuntime(deps);
}
