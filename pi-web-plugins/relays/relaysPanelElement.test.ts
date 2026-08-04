// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { FileContentResponse, FileTreeEntry, WorkspaceFiles, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import { RELAYS_ROOT, type RelayDiscoveryFiles } from "./relayDiscovery";
import { defineRelaysPanelElement, relaysPanelTagName } from "./relaysPanelElement";

interface RelaysPanelTestElement extends HTMLElement {
  context: WorkspacePanelContext | undefined;
}

declare global {
  interface HTMLElementTagNameMap {
    "pi-web-relays-panel": RelaysPanelTestElement;
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("workspace states", () => {
  it("asks for a workspace when no context is set", async () => {
    const panel = await mountPanel();

    expect(shadow(panel).textContent).toContain("Select a workspace.");
  });

  it("explains the relays convention when the workspace has no relays root", async () => {
    // The fake rejects unknown paths with "Path does not exist".
    const panel = await mountPanel(panelContext(workspaceFilesFake()));

    expect(viewerText(panel)).toContain("No relays in this workspace.");
    expect(viewerText(panel)).toContain(`${RELAYS_ROOT}/<name>/`);
  });

  it("shows the same empty state when the relays root exists but is empty", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, []);

    const panel = await mountPanel(panelContext(fake));

    expect(viewerText(panel)).toContain("No relays in this workspace.");
  });

  it("surfaces a scan failure with its detail", async () => {
    const fake = workspaceFilesFake();
    fake.failWith(RELAYS_ROOT, new Error("connection lost"));

    const panel = await mountPanel(panelContext(fake));

    const error = shadow(panel).querySelector(".status.error");
    expect(error?.textContent).toContain("Could not scan workspace relays.");
    expect(error?.textContent).toContain("connection lost");
  });
});

describe("single relay", () => {
  it("auto-opens the relay without a picker and renders its default document", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("only-relay", "2026-02-01T00:00:00.000Z")]);
    fake.addDirectory(`${RELAYS_ROOT}/only-relay`, [
      relayDocument("only-relay", "charter.md"),
      relayDocument("only-relay", "status.md"),
    ]);
    fake.addDocument(`${RELAYS_ROOT}/only-relay/status.md`, "# Status\nAll good.");
    fake.addDocument(`${RELAYS_ROOT}/only-relay/charter.md`, "# Charter");

    const panel = await mountPanel(panelContext(fake));

    expect(picker(panel)).toBeNull();
    expect(shadow(panel).querySelector(".relay-name")?.textContent).toBe("only-relay");
    expect(tabNames(panel)).toEqual(["status.md", "charter.md"]);
    expect(activeTab(panel)?.textContent).toBe("status.md");
    expect(documentText(panel)).toContain("All good.");
    expect(fake.readFile).toHaveBeenCalledWith(`${RELAYS_ROOT}/only-relay/status.md`);
  });

  it("escapes filesystem-derived names and paths", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("<img src=x>")]);
    fake.addDirectory(`${RELAYS_ROOT}/<img src=x>`, [relayDocument("<img src=x>", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/<img src=x>/status.md`, "safe");

    const panel = await mountPanel(panelContext(fake));

    expect(shadow(panel).querySelector("img")).toBeNull();
    expect(shadow(panel).querySelector(".relay-name")?.textContent).toBe("<img src=x>");
  });
});

describe("multiple relays", () => {
  it("pre-selects the most recently modified relay and opens another on picker change", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [
      relayDirectory("older", "2026-01-01T00:00:00.000Z"),
      relayDirectory("newer", "2026-03-01T00:00:00.000Z"),
    ]);
    fake.addDirectory(`${RELAYS_ROOT}/newer`, [relayDocument("newer", "status.md")]);
    fake.addDirectory(`${RELAYS_ROOT}/older`, [relayDocument("older", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/newer/status.md`, "newer status");
    fake.addDocument(`${RELAYS_ROOT}/older/status.md`, "older status");

    const panel = await mountPanel(panelContext(fake));

    expect(picker(panel)?.value).toBe(`${RELAYS_ROOT}/newer`);
    expect(documentText(panel)).toBe("newer status");

    const select = picker(panel);
    if (select === null) throw new Error("relay picker missing");
    select.value = `${RELAYS_ROOT}/older`;
    select.dispatchEvent(new Event("change", { bubbles: true })); // Real change events bubble; the panel listens at the region container.
    await flushAsync();

    expect(fake.listFiles).toHaveBeenCalledWith(`${RELAYS_ROOT}/older`);
    expect(documentText(panel)).toBe("older status");
  });
});

describe("document tabs", () => {
  it("orders tabs with anchor documents first and loads the clicked tab's document", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [
      relayDocument("relay", "notes.md"),
      relayDocument("relay", "log.md"),
      relayDocument("relay", "data.json"),
      relayDocument("relay", "charter.md"),
      relayDocument("relay", "status.md"),
    ]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, "status body");
    fake.addDocument(`${RELAYS_ROOT}/relay/log.md`, "log body");

    const panel = await mountPanel(panelContext(fake));

    expect(tabNames(panel)).toEqual(["status.md", "charter.md", "log.md", "data.json", "notes.md"]);
    expect(activeTab(panel)?.textContent).toBe("status.md");

    tabNamed(panel, "log.md").click();
    await flushAsync();

    expect(fake.readFile).toHaveBeenCalledWith(`${RELAYS_ROOT}/relay/log.md`);
    expect(activeTab(panel)?.textContent).toBe("log.md");
    expect(documentText(panel)).toBe("log body");
  });

  it("renders all document tabs as direct children of one tab strip", async () => {
    // The strip scrolls horizontally instead of wrapping, so every tab must be
    // a direct child of the single nav.document-tabs row.
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [
      relayDocument("relay", "notes.md"),
      relayDocument("relay", "log.md"),
      relayDocument("relay", "status.md"),
    ]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, "status body");

    const panel = await mountPanel(panelContext(fake));

    const strips = shadow(panel).querySelectorAll("nav.document-tabs");
    expect(strips.length).toBe(1);
    const strip = strips[0];
    expect(strip?.getAttribute("aria-label")).toBe("Relay documents");
    const children = [...(strip?.children ?? [])];
    expect(children.every((child) => child instanceof HTMLButtonElement)).toBe(true);
    expect(children.map((child) => child.textContent)).toEqual(["status.md", "log.md", "notes.md"]);
  });

  it("keeps the tab strip mounted with its scroll and focus when switching documents", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [
      relayDocument("relay", "notes.md"),
      relayDocument("relay", "log.md"),
      relayDocument("relay", "status.md"),
    ]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, "status body");
    fake.addDocument(`${RELAYS_ROOT}/relay/log.md`, "log body");

    const panel = await mountPanel(panelContext(fake));
    const strip = tabStrip(panel);
    strip.scrollLeft = 120;
    const logTab = tabNamed(panel, "log.md");

    logTab.click();
    await flushAsync();

    // Switching documents only re-renders the viewer: the strip element and
    // its buttons stay mounted, so scroll position and button identity survive.
    expect(documentText(panel)).toBe("log body");
    expect(tabStrip(panel)).toBe(strip);
    expect(tabStrip(panel).scrollLeft).toBe(120);
    expect(tabNamed(panel, "log.md")).toBe(logTab);
    expect(activeTab(panel)?.textContent).toBe("log.md");
  });

  it("scrolls the viewer back to the top when switching documents", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "log.md"), relayDocument("relay", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, "status body");
    fake.addDocument(`${RELAYS_ROOT}/relay/log.md`, "log body");

    const panel = await mountPanel(panelContext(fake));
    const viewer = shadow(panel).querySelector("section.viewer");
    if (!(viewer instanceof HTMLElement)) throw new Error("viewer missing");
    viewer.scrollTop = 80;

    tabNamed(panel, "log.md").click();
    await flushAsync();

    expect(documentText(panel)).toBe("log body");
    expect(viewer.scrollTop).toBe(0);
  });

  it("starts a different relay's tab strip at the left edge", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [
      relayDirectory("alpha", "2026-01-01T00:00:00.000Z"),
      relayDirectory("beta", "2026-02-01T00:00:00.000Z"),
    ]);
    fake.addDirectory(`${RELAYS_ROOT}/alpha`, [relayDocument("alpha", "status.md")]);
    fake.addDirectory(`${RELAYS_ROOT}/beta`, [relayDocument("beta", "status.md"), relayDocument("beta", "log.md")]);
    fake.addDocument(`${RELAYS_ROOT}/beta/status.md`, "beta status");
    fake.addDocument(`${RELAYS_ROOT}/alpha/status.md`, "alpha status");

    const panel = await mountPanel(panelContext(fake));
    tabStrip(panel).scrollLeft = 120;

    const select = picker(panel);
    if (select === null) throw new Error("relay picker missing");
    select.value = `${RELAYS_ROOT}/alpha`;
    select.dispatchEvent(new Event("change", { bubbles: true })); // Real change events bubble; the panel listens at the region container.
    await flushAsync();

    expect(documentText(panel)).toBe("alpha status");
    expect(tabStrip(panel).scrollLeft).toBe(0);
  });

  it("shows a truncation notice when the open document is truncated", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "log.md")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/log.md`, "partial log", { truncated: true });

    const panel = await mountPanel(panelContext(fake));

    expect(shadow(panel).querySelector(".status.info")?.textContent).toContain("truncated");
    expect(documentText(panel)).toBe("partial log");
  });

  it("explains when a document has no text preview", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, "AAAA", { binary: true });

    const panel = await mountPanel(panelContext(fake));

    expect(viewerText(panel)).toContain("Binary file: status.md");
    expect(shadow(panel).querySelector("pre.document")).toBeNull();
  });

  it("explains when the open document vanishes between listing and read", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "status.md")]);
    // No addDocument: the fake readFile rejects with "Path does not exist".

    const panel = await mountPanel(panelContext(fake));

    expect(viewerText(panel)).toContain("This document no longer exists.");
  });

  it("explains when a relay has no documents", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, []);

    const panel = await mountPanel(panelContext(fake));

    expect(viewerText(panel)).toContain("This relay has no documents yet.");
  });
});

describe("markdown rendering", () => {
  it("renders .md documents as sanitized markdown HTML", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, [
      "# Status",
      "",
      "See [the docs](https://example.com/docs).",
      "",
      "<script>alert('xss')</script>",
      "",
      "[click](javascript:alert('xss'))",
    ].join("\n"));

    const panel = await mountPanel(panelContext(fake));

    const rendered = shadow(panel).querySelector(".document.markdown");
    expect(rendered).not.toBeNull();
    expect(shadow(panel).querySelector("pre.document")).toBeNull();
    expect(rendered?.querySelector("h1")?.textContent).toBe("Status");
    expect(rendered?.querySelector("script")).toBeNull();
    const docsLink = rendered?.querySelector('a[href="https://example.com/docs"]');
    expect(docsLink?.getAttribute("target")).toBe("_blank");
    expect(docsLink?.getAttribute("rel")).toBe("noreferrer noopener");
    const unsafeLink = [...rendered?.querySelectorAll("a") ?? []].find((link) => link.textContent === "click");
    expect(unsafeLink?.hasAttribute("href")).toBe(false);
  });

  it("keeps non-markdown documents as escaped preformatted text", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "notes.txt")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/notes.txt`, "# not a heading\n<script>alert('xss')</script>");

    const panel = await mountPanel(panelContext(fake));

    expect(shadow(panel).querySelector(".document.markdown")).toBeNull();
    const pre = shadow(panel).querySelector("pre.document");
    expect(pre?.textContent).toContain("# not a heading");
    expect(shadow(panel).querySelector(".viewer h1")).toBeNull();
    expect(shadow(panel).querySelector(".viewer script")).toBeNull();
  });

  it("keeps the truncation notice ahead of rendered markdown", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "log.md")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/log.md`, "# Partial", { truncated: true });

    const panel = await mountPanel(panelContext(fake));

    const viewer = shadow(panel).querySelector(".viewer");
    expect(viewer?.querySelector(".status.info")?.textContent).toContain("truncated");
    expect(viewer?.querySelector(".document.markdown h1")?.textContent).toBe("Partial");
  });
});

describe("refresh and context changes", () => {
  it("renders Refresh as an icon-only button with an accessible name", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, []);

    const panel = await mountPanel(panelContext(fake));

    const button = refreshButton(panel);
    expect(button.getAttribute("aria-label")).toBe("Refresh");
    expect(button.getAttribute("title")).toBe("Refresh");
    expect(button.textContent.trim()).toBe("");
    const icon = button.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");

    fake.listFiles.mockClear();
    button.click();
    await flushAsync();
    expect(fake.listFiles).toHaveBeenCalledWith(RELAYS_ROOT);
  });

  it("re-scans on Refresh while keeping the open relay and document", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [
      relayDirectory("alpha", "2026-01-01T00:00:00.000Z"),
      relayDirectory("beta", "2026-02-01T00:00:00.000Z"),
    ]);
    fake.addDirectory(`${RELAYS_ROOT}/alpha`, [relayDocument("alpha", "status.md"), relayDocument("alpha", "log.md")]);
    fake.addDirectory(`${RELAYS_ROOT}/beta`, [relayDocument("beta", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/alpha/status.md`, "alpha status");
    fake.addDocument(`${RELAYS_ROOT}/alpha/log.md`, "alpha log");
    fake.addDocument(`${RELAYS_ROOT}/beta/status.md`, "beta status");

    const panel = await mountPanel(panelContext(fake));
    const select = picker(panel);
    if (select === null) throw new Error("relay picker missing");
    select.value = `${RELAYS_ROOT}/alpha`;
    select.dispatchEvent(new Event("change", { bubbles: true })); // Real change events bubble; the panel listens at the region container.
    await flushAsync();
    tabNamed(panel, "log.md").click();
    await flushAsync();
    expect(documentText(panel)).toBe("alpha log");

    fake.listFiles.mockClear();
    fake.readFile.mockClear();
    refreshButton(panel).click();
    await flushAsync();

    expect(fake.listFiles).toHaveBeenCalledWith(RELAYS_ROOT);
    expect(fake.listFiles).toHaveBeenCalledWith(`${RELAYS_ROOT}/alpha`);
    expect(fake.readFile).toHaveBeenCalledWith(`${RELAYS_ROOT}/alpha/log.md`);
    expect(picker(panel)?.value).toBe(`${RELAYS_ROOT}/alpha`);
    expect(activeTab(panel)?.textContent).toBe("log.md");
    expect(documentText(panel)).toBe("alpha log");
  });

  it("does not rescan when the same workspace context is set again, but rescans for a new workspace", async () => {
    const fake = workspaceFilesFake();
    fake.addDirectory(RELAYS_ROOT, [relayDirectory("relay")]);
    fake.addDirectory(`${RELAYS_ROOT}/relay`, [relayDocument("relay", "status.md")]);
    fake.addDocument(`${RELAYS_ROOT}/relay/status.md`, "status");

    const panel = await mountPanel(panelContext(fake));
    const callsAfterMount = fake.listFiles.mock.calls.length;

    panel.context = panelContext(fake);
    await flushAsync();
    expect(fake.listFiles.mock.calls.length).toBe(callsAfterMount);

    panel.context = panelContext(fake, "ws-2");
    await flushAsync();
    expect(fake.listFiles.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});

interface WorkspaceFilesFake {
  files: WorkspaceFiles;
  listFiles: Mock<RelayDiscoveryFiles["listFiles"]>;
  readFile: Mock<RelayDiscoveryFiles["readFile"]>;
  addDirectory(path: string, entries: FileTreeEntry[]): void;
  addDocument(path: string, content: string, overrides?: Partial<FileContentResponse>): void;
  failWith(path: string, error: Error): void;
}

/** In-memory WorkspaceFiles fake: unknown paths reject with "Path does not exist", like the real helper. */
function workspaceFilesFake(): WorkspaceFilesFake {
  const directories = new Map<string, FileTreeEntry[]>();
  const documents = new Map<string, FileContentResponse>();
  const failures = new Map<string, Error>();
  const listFiles = vi.fn<RelayDiscoveryFiles["listFiles"]>((path) => {
    const failure = failures.get(path);
    if (failure !== undefined) return Promise.reject(failure);
    const entries = directories.get(path);
    if (entries === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve({ path, entries, scannedAt: "2026-01-01T00:00:00.000Z", truncated: false });
  });
  const readFile = vi.fn<RelayDiscoveryFiles["readFile"]>((path) => {
    const failure = failures.get(path);
    if (failure !== undefined) return Promise.reject(failure);
    const file = documents.get(path);
    if (file === undefined) return Promise.reject(new Error("Path does not exist"));
    return Promise.resolve(file);
  });
  return {
    files: {
      listFiles,
      readFile,
      // The panel is read-only; the mutating helpers exist only to satisfy WorkspaceFiles.
      writeFile: () => Promise.reject(new Error("writeFile not used")),
      deleteFile: () => Promise.reject(new Error("deleteFile not used")),
      moveFile: () => Promise.reject(new Error("moveFile not used")),
    },
    listFiles,
    readFile,
    addDirectory: (path, entries) => { directories.set(path, entries); },
    addDocument: (path, content, overrides = {}) => {
      documents.set(path, {
        path,
        encoding: "utf8",
        size: content.length,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        content,
        truncated: false,
        binary: false,
        ...overrides,
      });
    },
    failWith: (path, error) => { failures.set(path, error); },
  };
}

function panelContext(fake: WorkspaceFilesFake, workspaceId = "ws-1"): WorkspacePanelContext {
  return {
    machine: { id: "machine-1", name: "Local", kind: "local" },
    workspace: { id: workspaceId, projectId: "project-1", path: "/repo", label: "repo", isMain: true },
    files: fake.files,
    host: { requestRender: () => undefined },
    prompt: { insertText: () => undefined, getText: () => "", getSelection: () => null },
    terminal: { open: () => undefined, runCommand: () => Promise.reject(new Error("terminal not used")) },
  };
}

async function mountPanel(context?: WorkspacePanelContext): Promise<RelaysPanelTestElement> {
  defineRelaysPanelElement();
  const panel = document.createElement(relaysPanelTagName);
  document.body.append(panel);
  if (context !== undefined) panel.context = context;
  await flushAsync();
  return panel;
}

/** One macrotask drains the full microtask chain of the panel's immediate-fake scans. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function relayDirectory(name: string, modifiedAt?: string): FileTreeEntry {
  return { name, path: `${RELAYS_ROOT}/${name}`, type: "directory", ...(modifiedAt === undefined ? {} : { modifiedAt }) };
}

function relayDocument(relayName: string, name: string, modifiedAt?: string): FileTreeEntry {
  return { name, path: `${RELAYS_ROOT}/${relayName}/${name}`, type: "file", ...(modifiedAt === undefined ? {} : { modifiedAt }) };
}

function shadow(panel: RelaysPanelTestElement): ShadowRoot {
  const root = panel.shadowRoot;
  if (root === null) throw new Error("panel has no shadow root");
  return root;
}

function viewerText(panel: RelaysPanelTestElement): string {
  return shadow(panel).querySelector(".viewer")?.textContent ?? "";
}

/** Text of the open document viewer, whether it rendered markdown or a <pre> block. */
function documentText(panel: RelaysPanelTestElement): string | null {
  return shadow(panel).querySelector(".viewer .document")?.textContent.trim() ?? null;
}

function picker(panel: RelaysPanelTestElement): HTMLSelectElement | null {
  const select = shadow(panel).querySelector("select[data-relay-picker]");
  return select instanceof HTMLSelectElement ? select : null;
}

function refreshButton(panel: RelaysPanelTestElement): HTMLElement {
  const button = shadow(panel).querySelector("button[data-refresh]");
  if (!(button instanceof HTMLElement)) throw new Error("refresh button missing");
  return button;
}

function tabStrip(panel: RelaysPanelTestElement): HTMLElement {
  const strip = shadow(panel).querySelector("nav.document-tabs");
  if (!(strip instanceof HTMLElement)) throw new Error("tab strip missing");
  return strip;
}

function tabNames(panel: RelaysPanelTestElement): string[] {
  return [...shadow(panel).querySelectorAll("button[data-document-path]")].map((tab) => tab.textContent);
}

function activeTab(panel: RelaysPanelTestElement): Element | null {
  return shadow(panel).querySelector("button[data-document-path].active");
}

function tabNamed(panel: RelaysPanelTestElement, name: string): HTMLElement {
  const tab = [...shadow(panel).querySelectorAll("button[data-document-path]")].find((candidate) => candidate.textContent === name);
  if (!(tab instanceof HTMLElement)) throw new Error(`tab "${name}" not found`);
  return tab;
}
