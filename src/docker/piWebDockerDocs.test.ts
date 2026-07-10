import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PI_WEB_DOCKER_USER_COMMANDS } from "./piWebDockerCommandPlan.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerOneLine = "curl -fsSL https://raw.githubusercontent.com/jmfederico/pi-web/main/docker/install.sh | sh";

describe("pi-web-docker documentation", () => {
  it("documents the Docker one-line install in the Docker guide", async () => {
    const dockerReadme = await readRepoFile("docker/README.md");

    expect(dockerReadme).toContain(dockerOneLine);
    expect(dockerReadme).toContain("does not require Node.js or npm on the host");
  });

  it("keeps Docker setup documentation scoped to the Docker folder", async () => {
    const nonDockerDocs = await Promise.all([
      readRepoFile("README.md"),
      readRepoFile("docs/install.html"),
      readRepoFile("docs/plugins.md"),
      readRepoFile("docs/plugins.html"),
    ]);

    for (const content of nonDockerDocs) {
      expect(content).not.toContain(dockerOneLine);
      expect(content).not.toContain("pi-web-docker");
      expect(content).not.toContain("Docker beta");
      expect(content).not.toContain("Docker guide");
    }
  });

  it("keeps the Docker command matrix aligned with the canonical user command surface", async () => {
    const [dockerReadme, dockerEntrypoint] = await Promise.all([
      readRepoFile("docker/README.md"),
      readRepoFile("docker/pi-web-docker"),
    ]);

    expect(readDockerCommandMatrix(dockerReadme)).toEqual([...PI_WEB_DOCKER_USER_COMMANDS]);
    expect(readEntrypointCommandCases(dockerEntrypoint)).toEqual(new Set(PI_WEB_DOCKER_USER_COMMANDS));

    expect(dockerReadme).toContain("`pi-web-docker --dev status`");
    expect(dockerReadme).toContain("`./docker/pi-web-docker --dev start`");
    expect(dockerReadme).not.toContain("pi-web-docker-control");
    expect(dockerReadme).not.toContain("docker/scripts/docker-compose-dev");
  });
});

function readDockerCommandMatrix(dockerReadme: string): string[] {
  const normalizedReadme = normalizeLineEndings(dockerReadme);
  const commandMatrixSection = normalizedReadme.split("### Command matrix\n")[1]?.split("\n### Installer options")[0] ?? "";
  return Array.from(commandMatrixSection.matchAll(/^\| `([^`]+)` \|/gm), (match) => {
    const command = match[1];
    if (command === undefined) throw new Error("Docker command matrix row did not include a command");
    return command;
  });
}

function readEntrypointCommandCases(dockerEntrypoint: string): Set<string> {
  const normalizedEntrypoint = normalizeLineEndings(dockerEntrypoint);
  const commandCaseBlock = normalizedEntrypoint.slice(normalizedEntrypoint.indexOf('case "$command_name" in'));
  const commandCases = new Set<string>();
  for (const line of commandCaseBlock.split("\n")) {
    const match = /^ {2}([a-z][a-z-]*(?:\|[a-z][a-z-]*)*)(?:\|__run-detached)?\)$/.exec(line);
    if (match?.[1] === undefined) continue;
    for (const command of match[1].split("|")) commandCases.add(command);
  }
  return commandCases;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, "\n");
}

async function readRepoFile(relativePath: string): Promise<string> {
  return await readFile(join(repoRoot, relativePath), "utf8");
}
