import type { FastifyInstance } from "fastify";
import { AutomationService, type AutomationServiceLogger } from "../automations/automationService.js";
import { registerAutomationRoutes } from "../automations/automationRoutes.js";
import { AutomationSessionRunner, type AutomationSessionService } from "../automations/automationSessionRunner.js";
import { defaultAutomationDatabasePath, AutomationStore } from "../automations/automationStore.js";
import { AutomationWorkspaceAuthorizer, type AutomationProjectProvider, type AutomationWorkspaceProvider } from "../automations/automationWorkspaceAuthorizer.js";
import type { SessionEventHub } from "../realtime/sessionEventHub.js";

export interface SessiondAutomationRuntime {
  registerRoutes(app: FastifyInstance): void;
  acquireOwnership(): void;
  start(): void;
  stop(): Promise<void>;
  dispose(): void;
}

export interface SessiondAutomationRuntimeDependencies {
  env: NodeJS.ProcessEnv;
  projects: AutomationProjectProvider;
  workspaces: AutomationWorkspaceProvider;
  sessions: AutomationSessionService;
  events: Pick<SessionEventHub, "publishRealtime">;
  logger: AutomationServiceLogger;
}

export function createSessiondAutomationRuntime(deps: SessiondAutomationRuntimeDependencies): SessiondAutomationRuntime {
  const service = new AutomationService(
    new AutomationStore(defaultAutomationDatabasePath(deps.env)),
    new AutomationWorkspaceAuthorizer(deps.projects, deps.workspaces),
    new AutomationSessionRunner(deps.sessions),
    deps.events,
    deps.logger,
  );
  return {
    registerRoutes: (app) => { registerAutomationRoutes(app, service); },
    acquireOwnership: () => { service.acquireOwnership(); },
    start: () => { service.start(); },
    stop: () => service.stop(),
    dispose: () => { service.dispose(); },
  };
}
