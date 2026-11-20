#!/usr/bin/env node
// Adapt upstream matcher data to PI WEB's synchronous file-icon contribution.
// Artwork stays in the installed package; never execute upstream theme code.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";

const target = new URL("../src/client/src/plugins/themes/material/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL(import.meta.resolve("material-icon-theme/dist/material-icons.json")), "utf8"));
const groups = new Map();
for (const [field, property] of [["fileNames", "filenames"], ["fileExtensions", "extensions"]]) {
  for (const [matcher, icon] of Object.entries(manifest[field])) {
    // The host deliberately rejects path-based filename rules. Light variants
    // are unnecessary: consumers use these extension-specific shapes as masks.
    if (/[\\/]/u.test(matcher)) continue;
    if (!groups.has(icon)) groups.set(icon, { icon, filenames: [], extensions: [] });
    groups.get(icon)[property].push(property === "extensions" ? `.${matcher}` : matcher);
  }
}
function asset(id) {
  const filename = basename(manifest.iconDefinitions[id].iconPath);
  if (!/^[\w-]+(?:\.clone)?\.svg$/u.test(filename)) throw new Error(`Unexpected icon path: ${filename}`);
  return `asset(${JSON.stringify(filename)})`;
}
const rules = [...groups.values()].map(({ icon, filenames, extensions }) => `    { ${[
  ...(filenames.length ? [`filenames: ${JSON.stringify(filenames)}`] : []),
  ...(extensions.length ? [`extensions: ${JSON.stringify(extensions)}`] : []),
  `icon: ${asset(icon)}`,
].join(", ")} },`);
const content = `// Generated from material-icon-theme by scripts/import-material-file-icons.mjs. Do not edit.
import { resolveAppUrl } from "../../../appUrl";
import type { FileIconThemeContribution } from "../../types";

export function materialFileIcons(): Pick<FileIconThemeContribution, "file" | "files"> {
  const asset = (filename: string) => ({ url: resolveAppUrl(\`pi-web-dependencies/material-icon-theme/\${encodeURIComponent(filename)}\`) });
  return { file: ${asset(manifest.file)}, files: [
${rules.join("\n")}
  ] };
}
`;
await mkdir(target, { recursive: true });
const path = new URL("generated.ts", target);
let previous;
try { previous = await readFile(path, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (previous !== content) await writeFile(path, content);
console.log(`Generated ${groups.size} Material file-icon rules`);
