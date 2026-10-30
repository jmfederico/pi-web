import { expect, it } from "vitest";
import { html, svg } from "lit";
import example from "../../../../examples/transcript-renderer-plugin/src/index";
import type { TranscriptToolEntry, TranscriptMessageEntry } from "../../../plugin-api";
import { resolveTranscriptToolRenderer } from "./transcriptRenderers";

function renderers() {
  // Exercise example payload validation through production resolution; browser tests own mounting.
  const selected = example.activate({ apiVersion: 5, pluginId: "example", runtimePluginId: "example", html, svg,
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal }).contributions.transcriptRenderers;
  const registered = selected.map((renderer) => ({ ...renderer, pluginId: "example", localId: renderer.id }));
  const message = selected.find((renderer) => renderer.target === "custom-message");
  if (message?.target !== "custom-message") throw new Error("Missing example message renderer");
  const input = { scope: { machineId: "local", sessionId: "synthetic" }, signal: new AbortController().signal, fail: (error: unknown) => { throw error; } };
  return {
    tool: (entry: TranscriptToolEntry) => resolveTranscriptToolRenderer(entry.toolName, registered)?.render({ ...input, entry }),
    message: (entry: TranscriptMessageEntry) => message.render({ ...input, entry }),
  };
}

it("delegates other tool names without rendering a checks card", () => {
  const { tool } = renderers();
  expect(tool({ toolName: "another_tool", status: "success", details: { checks: [] } })).toBeUndefined();
});

it("renders missing in-flight details, but declines missing or malformed completed check results", () => {
  const { tool } = renderers();
  for (const status of ["pending", "running"] as const) expect(tool({ toolName: "example_checks", status })).toBeDefined();
  expect(tool({ toolName: "example_checks", status: "success" })).toBeUndefined();
  for (const details of [null, { checks: "invalid" }, { checks: [{ name: "", status: "passed" }] },
    { checks: [{ name: "Lint", status: "unknown" }] }, { checks: [], durationMs: -1 },
    { checks: [{ name: "Lint", status: "passed", durationMs: Infinity }] }]) {
    expect(tool({ toolName: "example_checks", status: "running", details })).toBeUndefined();
  }
});

it("accepts empty and structured results without requiring command arguments or output", () => {
  const { tool } = renderers();
  expect(tool({ toolName: "example_checks", status: "success", details: { checks: [] } })).toBeDefined();
  expect(tool({ toolName: "example_checks", status: "error", args: "not JSON", details: {
    checks: [{ name: "Contract", status: "failed", durationMs: 12 }], durationMs: 12,
  } })).toBeDefined();
});

it("declines malformed task notices and accepts both declared producer statuses", () => {
  const { message } = renderers();
  for (const details of [undefined, { title: " ", status: "completed", summary: "Done" },
    { title: "Build", status: "running", summary: "Working" }, { title: "Build", status: "failed" }]) {
    expect(message({ customType: "example.task-notice", content: "Original notice", details })).toBeUndefined();
  }
  for (const status of ["completed", "failed"]) expect(message({ customType: "example.task-notice", content: "Original notice",
    details: { title: "Build", status, summary: "Synthetic notice" } })).toBeDefined();
});
