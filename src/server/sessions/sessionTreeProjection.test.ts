import { describe, expect, it } from "vitest";
import { projectSessionTree, type ProjectableSessionTreeNode } from "./sessionTreeProjection.js";

function treeNode(
  entry: Record<string, unknown>,
  children: ProjectableSessionTreeNode[] = [],
  label?: unknown,
): ProjectableSessionTreeNode {
  return { entry, children, ...(label === undefined ? {} : { label }) };
}

function entry(id: string, parentId: string | null, type: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, parentId, type, timestamp: "2026-01-01T00:00:00.000Z", ...patch };
}

describe("projectSessionTree", () => {
  it("preserves complete pre-order structure while strictly excluding raw private fields", () => {
    const rootChildren: ProjectableSessionTreeNode[] = [];
    const assistantChildren: ProjectableSessionTreeNode[] = [];
    const root = treeNode(entry("root", null, "message", {
      message: {
        role: "user",
        content: [
          { type: "text", text: "hello\nworld", textSignature: "secret-text-signature" },
          { type: "image", mimeType: "image/png", data: "secret-image-base64" },
        ],
        providerState: "secret-user-provider-state",
      },
    }), rootChildren, "  Important\nroot  ");
    const assistant = treeNode(entry("assistant", "root", "message", {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret chain of thought", thinkingSignature: "secret-thinking-signature" },
          { type: "toolCall", name: "read", arguments: { path: "secret-tool-argument", thinkingSignature: "secret-argument-signature" }, thoughtSignature: "secret-thought-signature" },
        ],
        usage: { privateUsage: "secret-usage" },
        responseId: "secret-response-id",
        stopReason: "toolUse",
      },
    }), assistantChildren);
    const toolResult = treeNode(entry("tool", "assistant", "message", {
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "visible tool text" }],
        details: { token: "secret-tool-details" },
        unknownProviderField: "secret-tool-provider-field",
        isError: false,
      },
    }));
    const custom = treeNode(entry("custom", "root", "custom", {
      customType: "extension-state",
      data: { apiKey: "secret-extension-data" },
    }));
    const orphan = treeNode(entry("orphan", "missing-parent", "future_entry", {
      futurePayload: "secret-unknown-payload",
    }));
    rootChildren.push(assistant, custom);
    assistantChildren.push(toolResult);

    const snapshot = projectSessionTree([root, orphan], "tool");
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.nodes.map((node) => node.id)).toEqual(["root", "assistant", "tool", "custom", "orphan"]);
    expect(snapshot.activeLeafId).toBe("tool");
    expect(snapshot.activePathIds).toEqual(["root", "assistant", "tool"]);
    expect(snapshot.nodes[0]).toMatchObject({ kind: "user", summary: "hello world [image]", label: "Important root" });
    expect(snapshot.nodes[1]).toMatchObject({ kind: "assistant", summary: "Tool call: read" });
    expect(snapshot.nodes[2]).toMatchObject({ kind: "tool-result", summary: "Tool result (read): visible tool text" });
    expect(snapshot.nodes[3]).toMatchObject({ kind: "custom", summary: "Custom entry: extension-state" });
    expect(snapshot.nodes[4]).toMatchObject({ kind: "other", summary: "Entry: future_entry" });

    for (const secret of [
      "secret-text-signature",
      "secret-image-base64",
      "secret-user-provider-state",
      "secret chain of thought",
      "secret-thinking-signature",
      "secret-tool-argument",
      "secret-argument-signature",
      "secret-thought-signature",
      "secret-usage",
      "secret-response-id",
      "secret-tool-details",
      "secret-tool-provider-field",
      "secret-extension-data",
      "secret-unknown-payload",
    ]) expect(serialized).not.toContain(secret);
    for (const privateKey of ["thinkingSignature", "thoughtSignature", "arguments", "usage", "details", "data", "mimeType"]) {
      expect(serialized).not.toContain(privateKey);
    }
  });

  it("projects each supported entry kind from only its safe display fields", () => {
    const roots = [
      treeNode(entry("assistant-error", null, "message", { message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }], stopReason: "error", errorMessage: "private provider error" } })),
      treeNode(entry("tool-error", null, "message", { message: { role: "toolResult", toolName: "bash", content: [{ type: "image", data: "private-image", mimeType: "image/png" }], details: "private", isError: true } })),
      treeNode(entry("bash", null, "message", { message: { role: "bashExecution", command: "npm test", output: "private shell output", fullOutputPath: "/private/path" } })),
      treeNode(entry("custom-visible", null, "custom_message", { customType: "notice", content: "visible notice", display: true, details: "private" })),
      treeNode(entry("custom-hidden", null, "custom_message", { customType: "private-custom-type", content: "private hidden content", display: false })),
      treeNode(entry("compaction", null, "compaction", { summary: "compact summary", details: "private" })),
      treeNode(entry("branch", null, "branch_summary", { summary: "branch summary", details: "private" })),
      treeNode(entry("model", null, "model_change", { provider: "anthropic", modelId: "claude" })),
      treeNode(entry("thinking", null, "thinking_level_change", { thinkingLevel: "high" })),
      treeNode(entry("info", null, "session_info", { name: "Tree work" })),
      treeNode(entry("label", null, "label", { targetId: "private-target", label: "checkpoint" })),
    ];

    const snapshot = projectSessionTree(roots, null);
    const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));

    expect(byId.get("assistant-error")).toMatchObject({ kind: "assistant", summary: "Assistant error" });
    expect(byId.get("tool-error")).toMatchObject({ kind: "tool-result", summary: "Tool error (bash): [image]" });
    expect(byId.get("bash")).toMatchObject({ kind: "bash", summary: "Shell: npm test" });
    expect(byId.get("custom-visible")).toMatchObject({ kind: "custom-message", summary: "Custom message (notice): visible notice" });
    expect(byId.get("custom-hidden")).toMatchObject({ kind: "custom-message", summary: "Hidden custom message" });
    expect(byId.get("compaction")).toMatchObject({ kind: "compaction", summary: "compact summary" });
    expect(byId.get("branch")).toMatchObject({ kind: "branch-summary", summary: "branch summary" });
    expect(byId.get("model")).toMatchObject({ kind: "model-change", summary: "Model: anthropic/claude" });
    expect(byId.get("thinking")).toMatchObject({ kind: "thinking-level-change", summary: "Thinking level: high" });
    expect(byId.get("info")).toMatchObject({ kind: "session-info", summary: "Session name: Tree work" });
    expect(byId.get("label")).toMatchObject({ kind: "label", summary: "Label: checkpoint" });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("rejects malformed SDK node wrappers and empty entry identities with clear boundary errors", () => {
    const malformedChild = {
      entry: entry("root", null, "custom", { customType: "root" }),
      children: [null],
    };
    const malformedChildren = {
      entry: entry("root", null, "custom", { customType: "root" }),
      children: "not-an-array",
    };

    expect(() => { Reflect.apply(projectSessionTree, undefined, [[malformedChild], null]); }).toThrow("Pi returned a malformed session-tree node");
    expect(() => { Reflect.apply(projectSessionTree, undefined, [[malformedChildren], null]); }).toThrow("Pi returned a malformed session-tree node");
    expect(() => projectSessionTree([treeNode(entry("", null, "custom"))], null)).toThrow("Pi returned a malformed session-tree entry");
    expect(() => projectSessionTree([treeNode(entry("   ", null, "custom"))], null)).toThrow("Pi returned a malformed session-tree entry");
    expect(() => projectSessionTree([treeNode(entry("child", "   ", "custom"))], null)).toThrow("Pi returned a malformed session-tree entry");
    expect(() => projectSessionTree([
      treeNode(entry("duplicate", null, "custom")),
      treeNode(entry("duplicate", null, "custom")),
    ], null)).toThrow("Pi returned duplicate session-tree entry IDs");
    expect(() => projectSessionTree([treeNode(entry("root", null, "custom"))], "missing")).toThrow("Pi returned an invalid active session-tree leaf");
  });

  it("keeps an existing active orphan as a one-node active path", () => {
    const snapshot = projectSessionTree([treeNode(entry("orphan", "missing-parent", "custom"))], "orphan");

    expect(snapshot.activeLeafId).toBe("orphan");
    expect(snapshot.activePathIds).toEqual(["orphan"]);
  });

  it("bounds summaries and traverses deep trees and malformed parent chains without recursion", () => {
    const depth = 5_000;
    let current = treeNode(entry(`node-${String(depth - 1)}`, `node-${String(depth - 2)}`, "message", {
      message: { role: "user", content: `${"word \n".repeat(200)}tail` },
    }));
    for (let index = depth - 2; index >= 0; index -= 1) {
      current = treeNode(entry(`node-${String(index)}`, index === 0 ? null : `node-${String(index - 1)}`, "message", {
        message: { role: "user", content: `message ${String(index)}` },
      }), [current]);
    }

    const snapshot = projectSessionTree([current], `node-${String(depth - 1)}`);
    const leaf = snapshot.nodes.at(-1);

    expect(snapshot.nodes).toHaveLength(depth);
    expect(snapshot.activePathIds).toHaveLength(depth);
    expect(leaf?.summary.length).toBeLessThanOrEqual(360);
    expect(leaf?.summary).not.toContain("\n");
    expect(leaf?.summary.endsWith("…")).toBe(true);

    const cycleAChildren: ProjectableSessionTreeNode[] = [];
    const cycleBChildren: ProjectableSessionTreeNode[] = [];
    const cycleA = treeNode(entry("cycle-a", "cycle-b", "custom", { customType: "a" }), cycleAChildren);
    const cycleB = treeNode(entry("cycle-b", "cycle-a", "custom", { customType: "b" }), cycleBChildren);
    cycleAChildren.push(cycleB);
    cycleBChildren.push(cycleA);
    const cyclicSnapshot = projectSessionTree([cycleA], "cycle-a");
    expect(cyclicSnapshot.nodes.map((node) => node.id)).toEqual(["cycle-a", "cycle-b"]);
    expect(cyclicSnapshot.activePathIds).toEqual(["cycle-b", "cycle-a"]);
  });
});
