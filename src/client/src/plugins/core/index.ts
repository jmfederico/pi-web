import type { PiWebPlugin } from "../types";
import type { ChatSessionWarningRow } from "../../components/chat/SessionWarnings";
import { createCoreActions } from "./actions";
import { createCoreMessageActions } from "./messageActions";
import { createCoreNoticesPanel } from "./notices";
import { createCoreManagedMcpPanel } from "./managedMcp";

export function createCorePlugin(getApplicationNotices?: () => readonly ChatSessionWarningRow[]): PiWebPlugin {
  return {
    apiVersion: 5,
    name: "PI WEB Core",
    activate: () => ({
      contributions: {
        actions: createCoreActions(),
        messageActions: createCoreMessageActions(),
        applicationPanels: [createCoreNoticesPanel(getApplicationNotices), createCoreManagedMcpPanel()],
      },
    }),
  };
}

export const corePlugin = createCorePlugin();
