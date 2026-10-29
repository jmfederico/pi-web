import { expect, it } from "vitest";
import { initialAppState } from "../appState";
import { machineSessionKey } from "../machineKeys";
import { PendingFormState } from "../pendingFormState";
import { SessionController } from "./sessionController";
import { defaultApi, deferred, FakeSocket, oldSession, status, workspace, type AppState } from "./sessionController.testSupport";

it("applies authoritative dialog cleanup to the response's originating machine after selection changes", async () => {
  const forms = new PendingFormState();
  const a = { scope: machineSessionKey("a", oldSession.id), kind: "dialog" as const, requestId: "same" };
  const b = { ...a, scope: machineSessionKey("b", oldSession.id) };
  forms.setInput(a, "answer on A");
  forms.setInput(b, "answer on B");
  const machine = (id: string): NonNullable<AppState["selectedMachine"]> => ({ id, name: id, kind: "remote", createdAt: "now", updatedAt: "now" });
  const response = deferred<ReturnType<typeof status>>();
  const bStatus = status(oldSession.id);
  let state: AppState = { ...initialAppState(), selectedMachine: machine("a"), selectedWorkspace: workspace, selectedSession: oldSession };
  const controller = new SessionController(() => state, (patch) => { state = { ...state, ...patch }; }, () => undefined, undefined, {
    api: { ...defaultApi, setModel: () => response.promise },
    socket: new FakeSocket(),
    onDialogSnapshot: (machineId, sessionId, ids) => { forms.syncDialogs(machineSessionKey(machineId, sessionId), ids); },
  });
  try {
    const pending = controller.setModel("provider", "model");
    state = { ...state, selectedMachine: machine("b"), status: bStatus };
    response.resolve(status(oldSession.id));
    await pending;
    expect(forms.get(a).input).toBe("");
    expect(forms.get(b).input).toBe("answer on B");
    expect(state.status).toBe(bStatus);
  } finally {
    controller.dispose();
  }
});
