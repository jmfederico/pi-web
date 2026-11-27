// Type-aware checks load a whole TypeScript program into memory. The root
// tsconfig.json is a solution that references smaller area projects, so the
// typecheck and lint scripts can process one area at a time and keep peak
// memory bounded by the largest area instead of the whole repository.
import { basename, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Reads the area projects referenced by a solution tsconfig, in reference order.
 * Each area lists its root files relative to `rootDir`.
 */
export function readTypeScriptAreas(rootDir, solutionConfig = "tsconfig.json") {
  const solution = parseConfig(resolve(rootDir, solutionConfig));
  const references = solution.projectReferences ?? [];
  if (references.length === 0) throw new Error(`${solutionConfig} references no area projects.`);
  return references.map((reference) => {
    const configPath = ts.resolveProjectReferencePath(reference);
    const parsed = parseConfig(configPath);
    return {
      name: basename(configPath, ".json"),
      configPath: relative(rootDir, configPath),
      files: parsed.fileNames.map((file) => relative(rootDir, file)),
    };
  });
}

/**
 * Splits areas into lint batches. Files shared by several areas, such as ambient
 * declarations, are linted once with the first area that lists them. Long file
 * lists are split so each command line stays within `maxArgumentLength`
 * characters; Windows limits a whole command line to 32,767 characters.
 */
export function lintBatches(areas, maxArgumentLength = 24_000) {
  const seen = new Set();
  const batches = [];
  for (const area of areas) {
    let files = [];
    let length = 0;
    for (const file of area.files) {
      if (seen.has(file)) continue;
      seen.add(file);
      if (files.length > 0 && length + file.length + 1 > maxArgumentLength) {
        batches.push({ area: area.name, files });
        files = [];
        length = 0;
      }
      files.push(file);
      length += file.length + 1;
    }
    if (files.length > 0) batches.push({ area: area.name, files });
  }
  return batches;
}

function parseConfig(configPath) {
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(formatDiagnostic(diagnostic));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
  if (parsed === undefined) throw new Error(`Unable to read ${configPath}.`);
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map(formatDiagnostic).join("\n"));
  return parsed;
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}
