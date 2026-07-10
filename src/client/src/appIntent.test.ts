import { describe, expect, it } from "vitest";
import { formatSharedText, parseAppIntent } from "./appIntent";

describe("parseAppIntent", () => {
  it("parses the new-session shortcut", () => {
    expect(parseAppIntent(new URLSearchParams("shortcut=new"))).toEqual({ kind: "new-session" });
  });

  it("parses the continue-last-session shortcut", () => {
    expect(parseAppIntent(new URLSearchParams("shortcut=continue-last"))).toEqual({ kind: "continue-last-session" });
  });

  it("ignores unknown shortcut values", () => {
    expect(parseAppIntent(new URLSearchParams("shortcut=bogus"))).toBeUndefined();
  });

  it("parses a share intent", () => {
    expect(parseAppIntent(new URLSearchParams("share_title=Bug&share_text=stack+trace&share_url=https://example.com"))).toEqual({
      kind: "share",
      title: "Bug",
      text: "stack trace",
      url: "https://example.com",
    });
  });

  it("parses a partial share intent", () => {
    expect(parseAppIntent(new URLSearchParams("share_text=hello"))).toEqual({ kind: "share", title: undefined, text: "hello", url: undefined });
  });

  it("returns undefined when there is no intent", () => {
    expect(parseAppIntent(new URLSearchParams("machine=local&session=abc"))).toBeUndefined();
  });
});

describe("formatSharedText", () => {
  it("joins title, text, and url with newlines", () => {
    expect(formatSharedText({ kind: "share", title: "Bug", text: "stack trace", url: "https://example.com" })).toBe("Bug\nstack trace\nhttps://example.com");
  });

  it("skips missing fields", () => {
    expect(formatSharedText({ kind: "share", text: "hello" })).toBe("hello");
  });

  it("returns an empty string when nothing was shared", () => {
    expect(formatSharedText({ kind: "share" })).toBe("");
  });
});
