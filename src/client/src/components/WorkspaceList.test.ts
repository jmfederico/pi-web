// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { trustApi } from "../api";
import type { Workspace } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { WorkspaceList } from "./WorkspaceList";

let restoreClipboardStub: () => void = () => undefined;

afterEach(() => {
  vi.restoreAllMocks();
  restoreClipboardStub();
  restoreClipboardStub = () => undefined;
  document.body.replaceChildren();
});

describe("workspace-list removal actions", () => {
  it("shows provider wording for neutral removal metadata and no removal action without it", async () => {
    const removable = workspace("neutral", {
      isMain: false,
      removal: {
        actionLabel: "Disconnect view",
        confirmation: "Disconnect this view without deleting files?",
        precondition: "removal-v1",
      },
    });
    const withoutRemoval = workspace("plain");
    const onDelete = vi.fn();
    const list = new WorkspaceList();
    list.workspaces = [removable, withoutRemoval];
    list.onDelete = onDelete;
    document.body.append(list);
    await list.updateComplete;

    const toggles = list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle");
    toggles?.[0]?.click();
    await list.updateComplete;

    const action = list.shadowRoot?.querySelector<HTMLButtonElement>(".workspace-menu-actions .danger");
    expect(action?.textContent).toBe("Disconnect view");
    expect(action?.title).toBe("Disconnect view");
    action?.click();
    expect(onDelete).toHaveBeenCalledWith(removable);
    await list.updateComplete;

    list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".action-menu-toggle")[1]?.click();
    await list.updateComplete;
    // The actions block stays visible for the project-trust toggle, but it
    // must not offer a removal action without removal metadata.
    expect(list.shadowRoot?.querySelector(".workspace-menu-actions")).not.toBeNull();
    expect(list.shadowRoot?.querySelector(".workspace-menu-actions .danger")).toBeNull();
  });
});

describe("workspace status indicator", () => {
  it("reads workspace status by workspace id", async () => {
    const list = await mountWorkspaceList(
      [workspace("ws-a"), workspace("ws-b")],
      machineStatusSnapshot({ workspaces: { "ws-b": { "core:unread": true } } }),
    );

    expect(unreadDot(rowFor(list, "ws-a"))).toBeNull();
    const dot = unreadDot(rowFor(list, "ws-b"));
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions in this workspace");
  });

  it("clears the dot once a newer snapshot reports nothing unread", async () => {
    const list = await mountWorkspaceList([workspace("ws-a")], machineStatusSnapshot({ workspaces: { "ws-a": { "core:unread": true } } }));
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.statusSnapshot = machineStatusSnapshot({ revision: 2 });
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when the workspace is busy and unread", async () => {
    const list = await mountWorkspaceList(
      [workspace("ws-a")],
      machineStatusSnapshot({ workspaces: { "ws-a": { "core:terminal": true, "core:unread": true } } }),
    );

    const row = rowFor(list, "ws-a");
    const ring = row.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.terminal")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions in this workspace · Workspace terminal active");
    expect(row.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("shows no indicator when the machine publishes no snapshot", async () => {
    const list = await mountWorkspaceList([workspace("ws-a")]);

    expect(rowFor(list, "ws-a").querySelector(".activity-indicator")).toBeNull();
  });

  it("still lights a row from a flag id this build does not know", async () => {
    const list = await mountWorkspaceList([workspace("ws-a")], machineStatusSnapshot({ workspaces: { "ws-a": { "core:future": true } } }));

    expect(rowFor(list, "ws-a").querySelector(".activity-indicator.session")).not.toBeNull();
  });
});

describe("workspace detail copy buttons", () => {
  it("copies the workspace path from the menu details and keeps the menu open", async () => {
    const writeText = stubClipboardWriteText(() => Promise.resolve());
    const list = await mountWorkspaceList([workspace("ws-a")]);
    openMenu(list, "ws-a");
    await list.updateComplete;

    detailCopyButton(list, "Copy path").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith("/repo/ws-a"); });
    await vi.waitFor(() => { expect(detailCopyButton(list, "Copied").textContent).toContain("✓"); });

    expect(list.shadowRoot?.querySelector(".workspace-menu-panel")).not.toBeNull();
  });

  it("copies the provider-authored workspace label without interpreting provider branch metadata", async () => {
    const writeText = stubClipboardWriteText(() => Promise.resolve());
    const listed = workspace("ws-a", {
      label: "review app",
      provider: {
        pluginId: "workspace-provider",
        capabilities: { request: true, remove: false },
        metadata: { branch: "feature-x" },
      },
    });
    const list = await mountWorkspaceList([listed]);
    openMenu(list, "review app");
    await list.updateComplete;

    detailCopyButton(list, "Copy workspace label").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith("review app"); });
    expect(list.shadowRoot?.querySelector(".workspace-detail-row dt")?.textContent).toBe("Workspace");
    expect(list.shadowRoot?.querySelector("[aria-label='Copy branch']")).toBeNull();
  });

  it("keeps the copy action unchanged when the clipboard write fails", async () => {
    const writeText = stubClipboardWriteText(() => Promise.reject(new Error("denied")));
    const list = await mountWorkspaceList([workspace("ws-a")]);
    openMenu(list, "ws-a");
    await list.updateComplete;

    detailCopyButton(list, "Copy path").click();
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalled(); });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    await list.updateComplete;

    expect(detailCopyButton(list, "Copy path")).toBeDefined();
    expect(list.shadowRoot?.querySelector(".workspace-menu-panel .detail-copy[aria-label='Copied']")).toBeNull();
  });
});

describe("workspace trust toggle documentation link", () => {
  it("links to the project-trust docs from the toggle's label row instead of verbose text", async () => {
    vi.spyOn(trustApi, "workspaceTrust").mockResolvedValue({ path: "/repo/ws-a", decision: true, trusted: true });
    const list = await mountWorkspaceList([workspace("ws-a")]);
    openMenu(list, "ws-a");
    await list.updateComplete;

    const trust = list.shadowRoot?.querySelector(".workspace-menu-trust");
    const link = trust?.querySelector<HTMLAnchorElement>("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("https://pi.dev/docs/latest/security");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
    expect(link?.textContent).toBe("Learn about project trust");
    // The verbose sentence is gone: the toggle row only labels the checkbox and links out.
    expect(trust?.textContent).not.toContain(".pi settings");
    // The obsolete Pi CLI / respectProjectTrust clause must not survive in any wording.
    expect(trust?.textContent).not.toMatch(/Pi CLI/i);
    expect(trust?.textContent).not.toMatch(/respectProjectTrust/);
  });
});

function openMenu(list: WorkspaceList, workspaceLabel: string): void {
  const toggle = rowFor(list, workspaceLabel).querySelector<HTMLButtonElement>(".action-menu-toggle");
  if (toggle === null) throw new Error(`Expected a menu toggle for ${workspaceLabel}`);
  toggle.click();
}

function detailCopyButton(list: WorkspaceList, label: string): HTMLButtonElement {
  const buttons = [...(list.shadowRoot?.querySelectorAll<HTMLButtonElement>(".workspace-menu-panel .detail-copy") ?? [])];
  const button = buttons.find((candidate) => candidate.getAttribute("aria-label") === label);
  if (button === undefined) throw new Error(`Expected a detail copy button labeled ${label}`);
  return button;
}

function stubClipboardWriteText(writeText: (text: string) => Promise<void>): Mock<(text: string) => Promise<void>> {
  const mock = vi.fn<(text: string) => Promise<void>>(writeText);
  const secureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const clipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText: mock }, configurable: true });
  restoreClipboardStub = () => {
    restoreStubbedProperty(window, "isSecureContext", secureContext);
    restoreStubbedProperty(window.navigator, "clipboard", clipboard);
  };
  return mock;
}

function restoreStubbedProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Object.defineProperty(target, key, descriptor);
}

async function mountWorkspaceList(workspaces: Workspace[], statusSnapshot?: MachineStatusSnapshot): Promise<WorkspaceList> {
  const list = new WorkspaceList();
  list.workspaces = workspaces;
  list.statusSnapshot = statusSnapshot;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: WorkspaceList, workspaceLabel: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".workspace-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(workspaceLabel));
  if (row === undefined) throw new Error(`Expected a workspace row for ${workspaceLabel}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function workspace(id: string, patch: Partial<Workspace> = {}): Workspace {
  return { id, projectId: "project-1", path: `/repo/${id}`, label: id, isMain: true, effectiveConfig: {}, ...patch };
}
