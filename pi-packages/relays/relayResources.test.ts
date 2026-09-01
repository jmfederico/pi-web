import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const promptNames = ["relay", "relay-worktree"] as const;
const skillNames = ["relay", "relay-runner"] as const;

/**
 * Guards the shipped layout of the Relay Pi package resources: Pi loads
 * `prompts/` and `skills/` from installed packages by convention, so a renamed
 * or malformed file would silently drop the feature.
 */
describe("Relay Pi package resources", () => {
  it.each(promptNames)("ships the /%s prompt template as a human-gated Relay preparer", async (name) => {
    const content = await readFile(join(__dirname, "prompts", `${name}.md`), "utf8");
    const frontmatter = frontmatterOf(content);

    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("argument-hint:");
    expect(content).toContain("$ARGUMENTS");
    expect(content).toContain("`relay`");
    expect(content).toContain("`relay-runner`");
    expect(content).toContain("ask_user");
    expect(content).toContain("Approve and dispatch");
    expect(content).toContain("dispatch still requires explicit human approval");
    expect(content).toContain("Draft — awaiting approval; not dispatched");
    expect(content).toContain("first bounded leg");
    expect(content).toContain("dispatch summary");
    expect(content).toContain("without further tool use");
    expect(content).not.toContain("## Whole-work review");
    expect(content).not.toContain("## Proportionate robustness");
  });

  it("keeps /relay-worktree as an explicit fresh-worktree compatibility alias", async () => {
    const content = await readFile(join(__dirname, "prompts", "relay-worktree.md"), "utf8");

    expect(frontmatterOf(content)).toContain("Compatibility alias for /relay");
    expect(content).toContain("fresh-worktree compatibility alias");
    expect(content).toContain("**fresh-worktree mode**");
    expect(content).toContain("move the packet from the drafting checkout");
    expect(content).toContain("remove the stale draft copy");
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

  it("leaves skill selection to dispatch and handoff prompts", async () => {
    const content = await readFile(join(__dirname, "..", "..", "skills", "relay-runner", "SKILL.md"), "utf8");
    const handoffStart = content.indexOf("Use this handoff shape");

    expect(handoffStart).toBeGreaterThan(0);
    expect(content.slice(0, handoffStart)).not.toContain("Load the `relay` skill");
    expect(content.slice(handoffStart)).toContain("Load the `relay` and `relay-runner` skills");
  });

  it("ends operational work at handoff and completes every profile gate", async () => {
    const base = await readFile(join(__dirname, "..", "..", "skills", "relay", "SKILL.md"), "utf8");
    const runner = await readFile(join(__dirname, "..", "..", "skills", "relay-runner", "SKILL.md"), "utf8");

    expect(base).toContain("final operational act");
    expect(base).toContain("A user-facing summary may follow");
    expect(runner).toContain("final operational action");
    expect(runner).toContain("After it returns, provide only a user-facing handoff summary");
    expect(runner).toContain("Relay completion means");
    expect(runner).toContain("required review, approval, or delivery remains");
  });

  it("keeps the Relay route adaptive instead of pre-planned", async () => {
    const content = await readFile(join(__dirname, "..", "..", "skills", "relay-runner", "SKILL.md"), "utf8");

    expect(content).toContain("Adaptive legs without an upfront plan");
    expect(content).toContain("select only the first bounded leg");
    expect(content).toContain("Do not create work packages");
    expect(content).toContain("Do not add `plan.md`");
    expect(content).toContain("The only optional packet files in this profile");
    expect(content).toContain("while a transitional checkpoint is active");
    expect(content).toContain("while unresolved whole-work findings require continuity");
  });

  it("keeps runner charters focused on goals and scope edges", async () => {
    const content = await readFile(join(__dirname, "..", "..", "skills", "relay-runner", "SKILL.md"), "utf8");
    const charterStart = content.indexOf("**`charter.md` — goal and edges.**");
    const operationsStart = content.indexOf("**`operations.md` — runner bindings.**");

    expect(charterStart).toBeGreaterThan(0);
    expect(operationsStart).toBeGreaterThan(charterStart);
    expect(content.slice(charterStart, operationsStart)).not.toContain("relay-runner");
    expect(content).toContain("`operations.md` — runner bindings");
    expect(content).toContain("packet and profile identity");
    expect(content).toContain("Do **not** put a quality bar");
    expect(content).toContain("canonical skills and documentation directly");
  });

  it("keeps review evidence-based and makes a third attempt exceptional", async () => {
    const content = await readFile(join(__dirname, "..", "..", "skills", "relay-runner", "SKILL.md"), "utf8");

    expect(content).toContain("two normal whole-work review attempts");
    expect(content).toContain("A third review is an exceptional contingency");
    expect(content).toContain("not an exhaustive search");
    expect(content).toContain("carry prior decisions forward");
    expect(content).toContain("do not automatically consume attempt 3");
    expect(content).toContain("materially changed review inputs made the prior approval stale");
    expect(content).toContain("Review cannot over-specify the agreement");
    expect(content).toContain("Reviewers are not expected or rewarded to produce findings");
    expect(content).toContain("do **not** dispatch remediation or a fourth review");
    expect(content).not.toContain("review attempts: N/3");
    expect(content).not.toContain("review attempts `0/3`");
  });
});

function frontmatterOf(content: string): string {
  return /^---\n(?<frontmatter>[\s\S]*?)\n---/u.exec(content)?.groups?.["frontmatter"] ?? "";
}
