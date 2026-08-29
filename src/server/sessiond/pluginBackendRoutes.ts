import type { FastifyInstance, FastifyReply } from "fastify";
import { isPiWebPluginId } from "../../shared/pluginIds.js";
import {
  parsePluginBackendRequestEnvelope,
  PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES,
  PLUGIN_BACKEND_BINARY_REVISION_HEADER,
  PLUGIN_BACKEND_BINARY_ROUTE_SUFFIX,
  PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES,
  PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
  requirePluginBackendOperation,
  requirePluginBackendRevision,
  serializeBoundedPluginBackendJson,
  type PluginBackendRequestEnvelope,
} from "../../shared/pluginBackendProtocol.js";
import type { Project } from "../types.js";
import {
  WorkspaceProviderRequestError,
  type WorkspaceProviderBinaryRequest,
  type WorkspaceProviderRequest,
} from "../workspaces/workspaceProviderRegistry.js";

interface PluginBackendRouteParams {
  pluginId: string;
  projectId: string;
  workspaceId: string;
  operation: string;
}

export interface PluginBackendProjectReader {
  requireProject(projectId: string): Promise<Project>;
}

export interface PluginBackendDispatcher {
  request(request: WorkspaceProviderRequest): Promise<unknown>;
  requestBinary(request: WorkspaceProviderBinaryRequest): Promise<unknown>;
}

export interface PluginBackendRouteDependencies {
  projects: PluginBackendProjectReader;
  backends: PluginBackendDispatcher;
  /**
   * Reports that the project's workspaces may have changed. A provider
   * operation is opaque here, so every completed request is reported rather
   * than guessing which operations create or remove a workspace.
   */
  onWorkspacesMutated: () => void;
}

/** JSON-only sessiond boundary for the active owner of one current workspace. */
export function registerPluginBackendRoutes(
  app: FastifyInstance,
  dependencies: PluginBackendRouteDependencies,
  prefix = "/plugin-backends",
): void {
  // The binary sibling route receives raw bodies; other sessiond routes keep
  // their existing parsers, and unknown content types still fail closed.
  try {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => { done(null, body); });
  } catch { /* already registered */ }

  app.post<{ Params: PluginBackendRouteParams; Body: unknown }>(
    `${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation`,
    { bodyLimit: PLUGIN_BACKEND_REQUEST_BODY_MAX_BYTES },
    async (request, reply) => {
      const { pluginId, projectId, workspaceId } = request.params;
      let operation = request.params.operation;
      let envelope: PluginBackendRequestEnvelope;
      try {
        if (!isPiWebPluginId(pluginId)) throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
        operation = requirePluginBackendOperation(operation);
        if (projectId === "") throw new Error("Project id is required");
        if (workspaceId === "") throw new Error("Workspace id is required");
        envelope = parsePluginBackendRequestEnvelope(request.body);
      } catch (error) {
        return attributedError(reply, 400, boundedErrorMessage(error), "invalid-request", pluginId, operation);
      }

      let project: Project;
      try {
        project = await dependencies.projects.requireProject(projectId);
      } catch (error) {
        const message = boundedErrorMessage(error);
        return attributedError(
          reply,
          message === "Project not found" ? 404 : 500,
          message,
          message === "Project not found" ? "project-not-found" : "project-resolution-failed",
          pluginId,
          operation,
        );
      }

      try {
        const result = await dependencies.backends.request({
          pluginId,
          moduleRevision: envelope.revision,
          project,
          workspaceId,
          operation,
          input: envelope.input,
        });
        const serialized = serializeBoundedPluginBackendJson(
          result,
          `Server plugin ${pluginId} operation ${operation} result`,
          PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
        );
        return await reply.type("application/json; charset=utf-8").send(serialized);
      } catch (error) {
        return await pluginBackendRequestFailed(reply, error, pluginId, operation);
      } finally {
        dependencies.onWorkspacesMutated();
      }
    },
  );

  // Opt-in raw binary sibling of the JSON route. The revision travels in a
  // header because the body is an opaque byte payload, not a JSON envelope.
  app.post<{ Params: PluginBackendRouteParams; Body: unknown }>(
    `${prefix}/:pluginId/projects/:projectId/workspaces/:workspaceId/:operation/${PLUGIN_BACKEND_BINARY_ROUTE_SUFFIX}`,
    { bodyLimit: PLUGIN_BACKEND_BINARY_BODY_MAX_BYTES },
    async (request, reply) => {
      const { pluginId, projectId, workspaceId } = request.params;
      let operation = request.params.operation;
      let revision: string;
      try {
        if (!isPiWebPluginId(pluginId)) throw new Error(`Invalid PI WEB plugin id: ${pluginId}`);
        operation = requirePluginBackendOperation(operation);
        if (projectId === "") throw new Error("Project id is required");
        if (workspaceId === "") throw new Error("Workspace id is required");
        revision = requirePluginBackendRevision(firstHeaderValue(request.headers[PLUGIN_BACKEND_BINARY_REVISION_HEADER]));
      } catch (error) {
        return attributedError(reply, 400, boundedErrorMessage(error), "invalid-request", pluginId, operation);
      }

      // Only the octet-stream parser yields a Buffer; any other body means the
      // request did not arrive as a raw binary payload.
      const body: unknown = request.body;
      if (!Buffer.isBuffer(body)) {
        return attributedError(
          reply,
          400,
          "Plugin backend binary request body must use content type application/octet-stream",
          "invalid-request",
          pluginId,
          operation,
        );
      }

      let project: Project;
      try {
        project = await dependencies.projects.requireProject(projectId);
      } catch (error) {
        const message = boundedErrorMessage(error);
        return attributedError(
          reply,
          message === "Project not found" ? 404 : 500,
          message,
          message === "Project not found" ? "project-not-found" : "project-resolution-failed",
          pluginId,
          operation,
        );
      }

      try {
        const result = await dependencies.backends.requestBinary({
          pluginId,
          moduleRevision: revision,
          project,
          workspaceId,
          operation,
          body,
        });
        const serialized = serializeBoundedPluginBackendJson(
          result,
          `Server plugin ${pluginId} operation ${operation} result`,
          PLUGIN_BACKEND_RESPONSE_JSON_MAX_BYTES,
        );
        return await reply.type("application/json; charset=utf-8").send(serialized);
      } catch (error) {
        return await pluginBackendRequestFailed(reply, error, pluginId, operation);
      } finally {
        dependencies.onWorkspacesMutated();
      }
    },
  );
}

function pluginBackendRequestFailed(
  reply: FastifyReply,
  error: unknown,
  pluginId: string,
  operation: string,
): FastifyReply {
  if (error instanceof WorkspaceProviderRequestError) {
    return attributedError(reply, error.statusCode, error.message, error.code, pluginId, operation);
  }
  return attributedError(
    reply,
    502,
    `Plugin backend request failed: ${boundedErrorMessage(error)}`,
    "request-failed",
    pluginId,
    operation,
  );
}

function attributedError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  code: string,
  pluginId: string,
  operation: string,
): FastifyReply {
  return reply.code(statusCode).send({ error: message, code, pluginId, operation });
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 2_048 ? message : `${message.slice(0, 2_045)}...`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
