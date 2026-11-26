import { describe, expect, it } from "vitest";
import { composeNotification } from "./message.js";

describe("composeNotification", () => {
  it("stays within the notification size limit by summarizing items that do not fit", () => {
    const items = Array.from({ length: 30 }, (_, index) => ({
      key: `review-comment:${String(index)}`, label: `Inline comment on ${"deep/".repeat(400)}file${String(index)}.ts`,
      excerpt: "Finding", url: `https://github.com/owner/repo/pull/7#discussion_r${String(index)}`,
    }));
    const content = composeNotification({ label: "owner/repo#7", url: "https://github.com/owner/repo/pull/7", title: "Add feature", headSha: null, verdict: null, items });
    expect(content.length).toBeLessThan(48 * 1024);
    const listed = items.filter((item) => content.includes(item.url)).length;
    expect(listed).toBeGreaterThan(0);
    expect(content).toContain(`…and ${String(items.length - listed)} more`);
    expect(content).toContain("pr_watch_unsubscribe");
  });
});
