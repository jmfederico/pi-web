import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

const DEFAULT_SEARCH_SERVER = "pi-web-default-search";

function hasConfig(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** Supply search only to profiles that have made no MCP configuration choice. */
export function withDefaultSearchMcp(mcp: ExtensionFactory): ExtensionFactory {
  return (pi) => {
    let registered = false;
    let considered = false;
    // Wait for startup registrations. Keep our namespace specific to PI WEB so
    // extensions can register their own parallel server at any lifecycle stage.
    pi.on("before_agent_start", (_event, ctx) => {
      if (considered) return;
      considered = true;
      // Even an empty, malformed, disabled, or untrusted project configuration
      // is an explicit choice. Never use a config error as a search fallback.
      if (hasConfig(join(getAgentDir(), "mcp.json"))
        || hasConfig(join(getAgentDir(), "mcp-auth.json"))
        || hasConfig(join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json"))
        || pi.getMcpServers().length > 0) return;

      pi.registerMcpServer(DEFAULT_SEARCH_SERVER, {
        url: "https://search.parallel.ai/mcp",
        headers: { "User-Agent": "pi-web (+https://github.com/jmfederico/pi-web)" },
        description: "Search the web and fetch pages with Parallel, without an account or API key.",
        exposure: "deferred",
        timeout: 30,
      });
      registered = true;
    });
    pi.on("mcp_servers_change", () => {
      if (registered && pi.getMcpServers().some((server) => server.name !== DEFAULT_SEARCH_SERVER)) {
        // Withdraw only our own default. An explicit server arriving later must
        // not leave an unconfigured fallback running, even if that server fails.
        registered = false;
        pi.unregisterMcpServer(DEFAULT_SEARCH_SERVER);
      }
    });
    // Keep the same builtin identity so Pi's replacement/disable controls apply.
    return mcp(pi);
  };
}
