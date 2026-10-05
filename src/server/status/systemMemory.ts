import { readFile } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import type { SystemMemory } from "../../shared/sessionActivity.js";

export function memoryFromProc(text: string): SystemMemory | undefined {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [key, value, unit] = line.trim().split(/\s+/);
    if ((key === "MemTotal:" || key === "MemAvailable:") && unit === "kB") values.set(key, Number(value) * 1024);
  }
  const totalBytes = values.get("MemTotal:");
  const availableBytes = values.get("MemAvailable:");
  if (totalBytes === undefined || availableBytes === undefined || !validMemory(totalBytes, availableBytes)) return undefined;
  return { totalBytes, availableBytes, availability: "available" };
}

export async function sampleSystemMemory(): Promise<SystemMemory> {
  if (process.platform === "linux") {
    // MemAvailable includes reclaimable cache; MemFree alone exaggerates pressure.
    const sample = memoryFromProc(await readFile("/proc/meminfo", "utf8"));
    if (sample === undefined) throw new Error("System memory sample is invalid");
    return sample;
  }
  const totalBytes = totalmem();
  const availableBytes = freemem();
  if (!validMemory(totalBytes, availableBytes)) throw new Error("System memory sample is invalid");
  return { totalBytes, availableBytes, availability: "free" };
}

function validMemory(total: number, available: number): boolean {
  return Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(available) && available >= 0 && available <= total;
}
