import {
  PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY, PI_WEB_HOST_SESSION_STATE_CAPABILITY,
  type PiWebServerPluginV5,
} from "@jmfederico/pi-web/server-plugin-api";
import { PrivateInputService } from "./service.js";

export default {
  apiVersion: 5,
  name: "Private input",
  requires: [PI_WEB_HOST_SESSION_STATE_CAPABILITY, PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
  activate(context) {
    let service: PrivateInputService | undefined;
    return {
      start({ capabilities }) {
        service = new PrivateInputService(
          capabilities.resolve(PI_WEB_HOST_SESSION_STATE_CAPABILITY),
          capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY),
          context.lifetimeSignal,
        );
      },
      peer: {
        request(request) {
          if (service === undefined) throw new Error("Private input is unavailable");
          return service.request(request);
        },
      },
    };
  },
} satisfies PiWebServerPluginV5;
