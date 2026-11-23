import {
  PI_WEB_HOST_CATALOG_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
  PI_WEB_HOST_SESSION_STATE_CAPABILITY, PI_WEB_HOST_PROJECT_TRUST_CAPABILITY,
  type JsonValue, type PiWebServerPluginV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { createManagedMcpConfigService, managedMcpAgentDir } from "./config.js";
import { McpManagerService } from "./service.js";

const plugin: PiWebServerPluginV5 = {
  apiVersion: 5,
  name: "MCP servers",
  requires: [PI_WEB_HOST_CATALOG_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY, PI_WEB_HOST_SESSION_STATE_CAPABILITY, PI_WEB_HOST_PROJECT_TRUST_CAPABILITY],
  activate() {
    let service: McpManagerService | undefined;
    return {
      start({ capabilities }) {
        service = new McpManagerService({
          config: createManagedMcpConfigService(), agentDir: managedMcpAgentDir(),
          catalog: capabilities.resolve(PI_WEB_HOST_CATALOG_CAPABILITY),
          events: capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY),
          states: capabilities.resolve(PI_WEB_HOST_SESSION_STATE_CAPABILITY),
          trust: capabilities.resolve(PI_WEB_HOST_PROJECT_TRUST_CAPABILITY),
        });
      },
      peer: {
        async request(request) {
          if (service === undefined) throw new Error("MCP manager has not started");
          const result = await service.request(request);
          // Project only the package's browser-safe DTO. Definitions never leave the server.
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Owned JSON DTO, not untrusted input.
          return JSON.parse(JSON.stringify(result)) as JsonValue;
        },
      },
      dispose() { service = undefined; },
    };
  },
};
export default plugin;
