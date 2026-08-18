import { readFile, writeFile } from "node:fs/promises";
import { isRecord } from "./sessionFileFormat.js";

/**
 * Mimics piSessionService's clearParentSession — rewrite the header in place
 * (truncate + write keeps the inode) with the parent link removed — and pads
 * the header back to its original byte length, so the rewrite is the one the
 * summary memo's identity + size key cannot see at all.
 */
export async function rewriteHeaderWithoutParentSession(path: string): Promise<void> {
  const content = await readFile(path, "utf8");
  const newlineIndex = content.indexOf("\n");
  const original = content.slice(0, newlineIndex);
  const parsed: unknown = JSON.parse(original);
  if (!isRecord(parsed)) throw new Error("Invalid session file header");
  delete parsed["parentSession"];
  const padKeyOverhead = JSON.stringify({ ...parsed, pad: "" }).length - JSON.stringify(parsed).length;
  const padLength = original.length - JSON.stringify(parsed).length - padKeyOverhead;
  if (padLength < 0) throw new Error("Header cannot be padded back to its original length");
  const rewritten = JSON.stringify({ ...parsed, pad: "x".repeat(padLength) });
  if (rewritten.length !== original.length) throw new Error("Padded header length does not match the original");
  await writeFile(path, `${rewritten}${content.slice(newlineIndex)}`, "utf8");
}
