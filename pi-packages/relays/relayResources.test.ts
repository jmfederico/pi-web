import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const promptNames = ["relay", "relay-worktree"] as const;
const skillNames = ["relay", "relay-runner"] as const;

/**
 * Guards discoverable resources and handoff entry points. These checks cannot
 * prove how a model will behave; avoid freezing a development lifecycle or
 * incidental prose into the package contract.
 */
describe("Relay Pi package resources", () => {
  it.each(promptNames)("ships /%s with task input, skill selection, and explicit dispatch approval", async (name) => {
    const content = await readFile(join(__dirname, "prompts", `${name}.md`), "utf8");
    const frontmatter = frontmatterOf(content);

    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("argument-hint:");
    expect(content).toContain("$ARGUMENTS");
    expect(content).toContain("`relay`");
    expect(content).toContain("`relay-runner`");
    expect(content).toContain("ask_user");
    expect(content).toContain("Approve and dispatch");
    expect(content).toContain("Revise");
    expect(content).toContain("Do not dispatch");
    expect(content).toContain("Draft — awaiting approval; not dispatched");
    expect(content).toContain("charter.md");
    expect(content).toContain("status.md");
    expect(content).toContain("log.md");
    expect(content).not.toContain("operations.md");
  });

  it("keeps the worktree command distinct from the in-place command", async () => {
    const inPlace = await readFile(join(__dirname, "prompts", "relay.md"), "utf8");
    const worktree = await readFile(join(__dirname, "prompts", "relay-worktree.md"), "utf8");

    expect(inPlace).toContain("current checkout");
    expect(worktree).toContain("fresh worktree");
    expect(worktree).toContain("move the packet there");
  });

  it.each(skillNames)("ships the %s skill with matching name and description frontmatter", async (name) => {
    const content = await readFile(join(__dirname, "skills", name, "SKILL.md"), "utf8");
    const frontmatter = frontmatterOf(content);

    expect(frontmatter).toContain(`name: ${name}`);
    expect(frontmatter).toContain("description:");
  });

  it.each(skillNames)("keeps the shipped %s skill identical to its canonical skill", async (name) => {
    const canonical = await readFile(join(__dirname, "..", "..", "skills", name, "SKILL.md"), "utf8");
    const shipped = await readFile(join(__dirname, "skills", name, "SKILL.md"), "utf8");

    expect(shipped).toBe(canonical);
  });

  it("keeps the base Relay method tool agnostic", async () => {
    const content = await readFile(join(__dirname, "..", "..", "skills", "relay", "SKILL.md"), "utf8");

    expect(content).not.toMatch(/\bspawn_session\b|\.pi-web|\bGit\b|\bPi\b|charter\.md|operations\.md|status\.md|log\.md/u);
  });

  it("gives a fresh successor the skills, goal, and baton without requiring full history", async () => {
    const content = await readFile(join(__dirname, "..", "..", "skills", "relay-runner", "SKILL.md"), "utf8");
    const handoff = /```text\n(?<prompt>[\s\S]*?)\n```/u.exec(content)?.groups?.["prompt"];

    expect(handoff).toBeDefined();
    expect(handoff).toContain("`relay`");
    expect(handoff).toContain("`relay-runner`");
    expect(handoff).toContain("<packet>/charter.md");
    expect(handoff).toContain("<packet>/status.md");
    expect(handoff).not.toContain("log.md");
    expect(handoff).not.toContain("operations.md");
    expect(content).toContain("spawn_session");
    expect(content).toContain("final operational action");
  });
});

function frontmatterOf(content: string): string {
  return /^---\n(?<frontmatter>[\s\S]*?)\n---/u.exec(content)?.groups?.["frontmatter"] ?? "";
}
