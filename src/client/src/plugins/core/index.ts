import type { PiWebPlugin } from "../types";
import { createCoreActions } from "./actions";
import { createCoreMessageActions } from "./messageActions";
export const corePlugin: PiWebPlugin = {
  apiVersion: 4,
  name: "PI WEB Core",
  activate: () => ({
    contributions: {
      actions: createCoreActions(),
      messageActions: createCoreMessageActions(),
    },
  }),
};
