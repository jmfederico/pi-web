import type { PiWebPlugin } from "../types";
import { createCoreActions } from "./actions";
export const corePlugin: PiWebPlugin = {
  apiVersion: 2,
  name: "PI WEB Core",
  activate: () => ({
    contributions: {
      actions: createCoreActions(),
    },
  }),
};
