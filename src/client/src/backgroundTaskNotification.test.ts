import { describe, expect, it } from "vitest";
import { backgroundTaskPresentation, backgroundTaskTone } from "./backgroundTaskNotification";
import { normalizeMessages } from "./chatMessages";
import { applyTranscriptEvent } from "./chatTranscript";
import { seedStreamingPartial } from "./chatTranscript";
import { messageActionMessage } from "./plugins/messageActions";

const raw = "<background-task-notification><task-id>task-1</task-id><status>completed</status></background-task-notification>";
const message = {
  role: "custom", customType: "background-task-notification", content: raw, entryId: "entry-1",
  details: { id: "task-1", name: "Run tests", command: "npm test", status: "completed", outputPath: ".pi/tasks/task-1.output", exitCode: 0 },
};

describe("background task notification presentation", () => {
  it.each(["completed", "failed", "killed", "running"])("preserves the structured %s state", (status) => {
    expect(backgroundTaskPresentation({ ...message, details: { ...message.details, status } })).toMatchObject({ kind: "backgroundTask", id: "task-1", status });
  });

  it.each([undefined, null, {}, { id: "t", status: "surprise" }, { id: "", status: "completed" }, { id: "t", status: "completed", exitCode: "0" }])("keeps malformed details as ordinary raw text: %j", (details) => {
    expect(normalizeMessages([{ ...message, details }])[0]?.parts).toEqual([{ type: "text", text: raw }]);
  });

  it("does not interpret XML in user/model messages or unrelated custom messages", () => {
    for (const override of [{ role: "user" }, { role: "assistant" }, { role: "system" }, { customType: "other" }]) {
      expect(backgroundTaskPresentation({ ...message, ...override })).toBeUndefined();
    }
  });

  it("keeps live, ended, history, and reconnect normalization identical without changing raw content", () => {
    const history = normalizeMessages([message]);
    expect(applyTranscriptEvent([], { type: "message.append", message })).toEqual(history);
    expect(applyTranscriptEvent([], { type: "message.end", message })).toEqual(history);
    expect(seedStreamingPartial(history, undefined)).toEqual(history);
    expect(normalizeMessages(history)).toEqual(history);
    expect(history[0]?.entryId).toBe("entry-1");
    expect(history[0]?.parts[0]).toMatchObject({ type: "text", text: raw, presentation: { kind: "backgroundTask", name: "Run tests" } });
  });

  it("preserves copy/action text", () => {
    const line = normalizeMessages([message])[0];
    if (line === undefined) throw new Error("Missing task notification");
    expect(messageActionMessage(line)?.text).toBe(raw);
  });

  it("does not turn missing names into missing notifications", () => {
    expect(backgroundTaskPresentation({ ...message, details: { id: "t", status: "killed", exitCode: null } })).toMatchObject({ name: "t", status: "killed", exitCode: null });
  });

  it.each([
    ["completed", 0, undefined, "success"],
    ["completed", 1, undefined, "danger"],
    ["completed", 0, "publication failed", "danger"],
    ["failed", null, undefined, "danger"],
    ["killed", null, undefined, "warning"],
    ["running", undefined, undefined, "warning"],
  ] as const)("maps %s exit %s to %s without treating null as zero", (status, exitCode, error, tone) => {
    expect(backgroundTaskTone({ kind: "backgroundTask", id: "t", name: "Task", status, ...(exitCode === undefined ? {} : { exitCode }), ...(error === undefined ? {} : { error }) })).toBe(tone);
  });
});
