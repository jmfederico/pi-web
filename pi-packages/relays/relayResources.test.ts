import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the shipped layout of the plugin's Pi resources: sessiond injects
 * `prompts/` and `skills/` into sessions by convention, so a renamed or
 * malformed file would silently drop the feature.
 */
describe("relays plugin Pi resources", () => {
  it.each(["relay", "relay-worktree"])("ships the /%s prompt template with frontmatter and argument expansion", async (name) => {
    const content = await readFile(join(__dirname, "prompts", `${name}.md`), "utf8");
    const frontmatter = frontmatterOf(content);

    expect(frontmatter).toContain("description:");
    expect(frontmatter).toContain("argument-hint:");
    expect(content).toContain("$ARGUMENTS");
  });

  it("ships the relay skill with name and description frontmatter", async () => {
    const content = await readFile(join(__dirname, "skills", "relay", "SKILL.md"), "utf8");
    const frontmatter = frontmatterOf(content);

    expect(frontmatter).toContain("name: relay");
    expect(frontmatter).toContain("description:");
  });

  it("keeps the shipped relay skill identical to the canonical skills/relay/SKILL.md", async () => {
    const canonical = await readFile(join(__dirname, "..", "..", "skills", "relay", "SKILL.md"), "utf8");
    const shipped = await readFile(join(__dirname, "skills", "relay", "SKILL.md"), "utf8");

    expect(shipped).toBe(canonical);
  });
});

function frontmatterOf(content: string): string {
  return /^---\n(?<frontmatter>[\s\S]*?)\n---/u.exec(content)?.groups?.["frontmatter"] ?? "";
}
