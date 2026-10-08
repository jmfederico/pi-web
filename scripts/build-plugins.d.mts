export function buildDirectory(sourceDir: string, targetDir: string): Promise<{ copied: number; transpiled: number }>;
export function buildTerminalPackage(sourceDir: string, targetDir: string): Promise<void>;
