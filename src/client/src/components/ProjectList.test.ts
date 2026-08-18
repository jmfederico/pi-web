// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import type { Project } from "../api";
import type { MachineStatusSnapshot } from "../../../shared/machineStatus";
import { machineStatusSnapshot } from "../machineStatus.testSupport";
import { ProjectList } from "./ProjectList";

afterEach(() => {
  document.body.replaceChildren();
});

describe("project status indicator", () => {
  it("shows an unread dot only on projects the snapshot reports as unread", async () => {
    const list = await mountProjectList(
      [project("project-a"), project("project-b")],
      machineStatusSnapshot({ projects: { "project-b": { "core:unread": true } } }),
    );

    expect(unreadDot(rowFor(list, "project-a"))).toBeNull();
    const dot = unreadDot(rowFor(list, "project-b"));
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("title")).toBe("Unread sessions in this project");
  });

  it("clears the dot once a newer snapshot reports nothing unread", async () => {
    const list = await mountProjectList([project("project-a")], machineStatusSnapshot({ projects: { "project-a": { "core:unread": true } } }));
    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).not.toBeNull();

    list.statusSnapshot = machineStatusSnapshot({ revision: 2 });
    await list.updateComplete;

    expect(list.shadowRoot?.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("wraps the work dot in an unread ring when the project is busy and unread", async () => {
    const list = await mountProjectList(
      [project("project-a")],
      machineStatusSnapshot({ projects: { "project-a": { "core:working": true, "core:unread": true } } }),
    );

    const row = rowFor(list, "project-a");
    const ring = row.querySelector(".unread-ring");
    expect(ring?.querySelector(".activity-indicator.session")).not.toBeNull();
    expect(ring?.getAttribute("title")).toBe("Unread sessions in this project · Project active");
    expect(row.querySelector(".activity-indicator.unread")).toBeNull();
  });

  it("lights a project whose workspaces have never been opened, for work and for unread", async () => {
    // The row reads the server-attributed snapshot, so it no longer depends on
    // the browser having loaded that project's workspaces.
    const list = await mountProjectList(
      [project("unvisited-work"), project("unvisited-unread")],
      machineStatusSnapshot({
        projects: { "unvisited-work": { "core:working": true }, "unvisited-unread": { "core:unread": true } },
      }),
    );

    expect(rowFor(list, "unvisited-work").querySelector(".activity-indicator.session")).not.toBeNull();
    expect(unreadDot(rowFor(list, "unvisited-unread"))).not.toBeNull();
  });

  it("shows no indicator when the machine publishes no snapshot", async () => {
    const list = await mountProjectList([project("project-a")], undefined);

    expect(rowFor(list, "project-a").querySelector(".activity-indicator")).toBeNull();
  });

  it("still lights a row from a flag id this build does not know", async () => {
    const list = await mountProjectList([project("project-a")], machineStatusSnapshot({ projects: { "project-a": { "core:future": true } } }));

    expect(rowFor(list, "project-a").querySelector(".activity-indicator.session")).not.toBeNull();
  });
});

async function mountProjectList(projects: Project[], statusSnapshot: MachineStatusSnapshot | undefined): Promise<ProjectList> {
  const list = new ProjectList();
  list.projects = projects;
  list.statusSnapshot = statusSnapshot;
  document.body.append(list);
  await list.updateComplete;
  return list;
}

function rowFor(list: ProjectList, projectName: string): Element {
  const rows = [...(list.shadowRoot?.querySelectorAll(".action-row") ?? [])];
  const row = rows.find((candidate) => candidate.textContent.includes(projectName));
  if (row === undefined) throw new Error(`Expected a project row for ${projectName}`);
  return row;
}

function unreadDot(row: Element): Element | null {
  return row.querySelector(".activity-indicator.unread");
}

function project(id: string): Project {
  return { id, name: id, path: `/repo/${id}`, createdAt: "2026-06-04T00:00:00.000Z" };
}
