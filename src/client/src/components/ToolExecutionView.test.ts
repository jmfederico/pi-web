// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { ToolExecutionView } from "./ToolExecutionView";

afterEach(() => {
  document.body.replaceChildren();
});

it.each(["const result = await tool();\nconsole.log(result);", { code: "const result = await tool();\nconsole.log(result);" }])("keeps complete code input and output inside preformatted boxes", async (args) => {
  const view = new ToolExecutionView();
  const code = typeof args === "string" ? args : args.code;
  const result = '<script>not markup</script>\n{"result": 1}';
  view.execution = { type: "toolExecution", toolName: "codemode", summary: "truncated", args, status: "success", resultText: result };
  document.body.append(view);
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".detail-target-value")?.textContent).toBe(code);
  expect(view.renderRoot.querySelector(".detail-result pre")?.textContent).toBe(result);
  expect(view.renderRoot.querySelector("script")).toBeNull();
});

it("starts diffs collapsed and keeps the user's disclosure choice across completion", async () => {
  const view = new ToolExecutionView();
  view.execution = { type: "toolExecution", toolName: "edit", summary: "Update file", status: "running", preview: { diff: "-old\n+new" } };
  document.body.append(view);
  await view.updateComplete;
  const details = view.shadowRoot?.querySelector<HTMLDetailsElement>(".diff-details");
  if (details == null) throw new Error("Expected diff disclosure");
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Preview diff");

  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  view.execution = { ...view.execution, status: "success", details: { diff: "-old\n+new" } };
  await view.updateComplete;
  expect(details.open).toBe(true);
  expect(details.textContent).toContain("Applied diff");
  expect(details.querySelector("code")?.textContent).toContain("+new");

  details.open = false;
  details.dispatchEvent(new Event("toggle"));
  await view.updateComplete;
  view.execution = { ...view.execution, summary: "Updated file" };
  await view.updateComplete;
  expect(details.open).toBe(false);
});

it("keeps failures and their details visible without opening a disclosure", async () => {
  const view = new ToolExecutionView();
  view.execution = { type: "toolExecution", toolName: "read", summary: "Read file", status: "error", resultText: "Permission denied" };
  document.body.append(view);
  await view.updateComplete;
  expect(view.shadowRoot?.querySelector(".status-label")?.textContent).toBe("failed");
  expect(view.shadowRoot?.querySelector(".error-text")?.textContent).toBe("Permission denied");
  expect(view.shadowRoot?.querySelector<HTMLDetailsElement>(".text-body")?.open).toBe(true);
});
