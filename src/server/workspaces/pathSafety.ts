import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export async function resolveInsideWorkspace(rootPath: string, relativePath: string | undefined): Promise<{ root: string; target: string; relativePath: string }> {
  const requested = normalizeRelativePath(relativePath);
  const root = await realpath(rootPath);
  const joined = join(root, requested);
  const target = await realpath(joined).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) throw new Error("Path does not exist");
    throw error;
  });
  ensureInside(root, target);
  return { root, target, relativePath: requested };
}

export async function resolveParentInsideWorkspace(rootPath: string, relativePath: string): Promise<{ root: string; target: string; relativePath: string }> {
  const requested = normalizeRelativePath(relativePath);
  const root = await realpath(rootPath);
  const target = join(root, requested);
  ensureInside(root, target);
  return { root, target, relativePath: requested };
}

export function normalizeRelativePath(input: string | undefined): string {
  const value = input ?? "";
  if (value === "" || value === ".") return "";
  if (isAbsolute(value)) throw new Error("Absolute paths are not allowed");
  const parts = value.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("Path traversal is not allowed");
  return parts.join("/");
}

export function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function ensureInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Path escapes workspace");
  if (sep !== "/" && rel.split(sep).includes("..")) throw new Error("Path escapes workspace");
}
