// @vitest-environment happy-dom
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { html } from "lit";
import { createContentRenderingCapability } from "../src/client/src/formatting/contentRendering.ts";
import { ContentRenderingBoundary } from "../src/client/src/components/ContentRenderingBoundary.ts";
import { ContentRendererHost } from "../src/client/src/components/ContentRendererHost.ts";

// Consume the built, production-Lit plugin alongside the development-Lit host.
// Source-only component tests share one runtime and cannot catch this failure.
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

it("loads saved Markdown Preview through the bundled Files plugin without crossing Lit directive runtimes", async () => {
  const files = await import(pathToFileURL(resolve("dist/pi-web-plugins/files/browser/pi-web-plugin.js")).href);
  files.defineFilesCustomElements();
  const viewer = document.createElement("pi-web-files-viewer");
  const text = "# Notes\n\n> ```diagram\n> source\n> ```\n\n[Safe](https://example.test)\n\n<script>bad()</script>";
  Object.assign(viewer, {
    machineId: "local",
    projectId: "project",
    workspaceId: "workspace",
    selectedPath: "notes.md",
    modeStore: { adopt: () => "preview", publish: () => undefined },
    contentRendering: createContentRenderingCapability(() => [{
      id: "diagram", label: "Diagram", renderer: { id: "diagram", render: ({ text }) => html`<b>${text}</b>` },
    }]),
  });
  document.body.append(viewer);
  await viewer.updateComplete;
  expect(viewer.shadowRoot.querySelector('[role="status"]').textContent).toContain("Loading notes.md");

  viewer.file = {
    path: "notes.md", mediaType: "markdown", language: "markdown", encoding: "utf8",
    size: text.length, modifiedAt: "2026-10-06T00:00:00.000Z", content: text, truncated: false, binary: false,
  };
  await viewer.updateComplete;
  const boundary = viewer.shadowRoot.querySelector("pi-web-content-rendering-boundary");
  expect(boundary).toBeInstanceOf(ContentRenderingBoundary);
  await boundary.updateComplete;
  const preview = viewer.shadowRoot.querySelector(".markdown-preview");
  expect(preview.querySelector("h1").textContent).toBe("Notes");
  expect(preview.querySelector("script")).toBeNull();
  expect(preview.querySelector("a").getAttribute("rel")).toBe("noopener noreferrer");
  expect(viewer.shadowRoot.querySelector('[role="status"]')).toBeNull();
  const host = preview.querySelector("blockquote pi-web-content-renderer");
  expect(host).toBeInstanceOf(ContentRendererHost);
  await host.updateComplete;
  expect(host.shadowRoot.querySelector("b").textContent).toBe("source");
  expect([...viewer.shadowRoot.querySelectorAll("button")].map((button) => button.textContent.trim())).toEqual(["Preview", "Raw"]);
});
