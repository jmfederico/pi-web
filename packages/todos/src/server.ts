import { join } from "node:path";
import type { PiWebServerPlugin } from "@jmfederico/pi-web/server-plugin-api";
import { TodoStore } from "./store.js";

const plugin: PiWebServerPlugin = {
  apiVersion: 3,
  name: "To-dos",
  activate(host) {
    const role = host.settings["role"];
    if (role !== "server" && role !== "client") throw new Error("Configure todos settings.role as server or client");
    if (role === "client") {
      const target = host.settings["targetMachineId"];
      const transport = host.transport;
      if (typeof target !== "string" || target.trim() === "" || target === "local" || target.includes("://")) throw new Error("Configure todos targetMachineId as a registered remote machine ID");
      if (transport?.version !== 1) throw new Error("Update PI WEB to use to-do backend transport");
      return {
        backend: {
          async request({ operation, input, signal }) {
            signal.throwIfAborted();
            host.lifetimeSignal.throwIfAborted();
            return await transport.request({ machineId: target, operation, input, signal });
          },
        },
      };
    }
    const store = new TodoStore(join(host.dataDirectory, "todos.sqlite"));
    return {
      backend: {
        request({ operation, input, signal }) {
          signal.throwIfAborted();
          host.lifetimeSignal.throwIfAborted();
          switch (operation) {
            case "list": return store.list(input);
            case "read": return store.read(input);
            case "mutate": return store.mutate(input);
            default: throw new Error(`Unknown to-do operation: ${operation}`);
          }
        },
      },
      dispose() { store.close(); },
    };
  },
};
export default plugin;
