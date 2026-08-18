import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piWebResourceLoaderOptions } from "./piSessionService.js";

/**
 * Exercised against pi's real resource loader: the value of this seam is that
 * PI WEB's deployment facts reach the system prompt *in addition to* the
 * operator's own append-prompt file, and only pi can prove that composition.
 */
describe("piWebResourceLoaderOptions", () => {
  let root = "";
  let agentDir = "";
  let cwd = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pi-web-system-prompt-"));
    agentDir = join(root, "agent");
    cwd = join(root, "workspace");
    await mkdir(agentDir);
    await mkdir(cwd);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function appendSystemPrompt(sections: readonly string[]): Promise<string[]> {
    const options = piWebResourceLoaderOptions(sections);
    const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, ...(options ?? {}) });
    await loader.reload();
    return loader.getAppendSystemPrompt();
  }

  it("appends PI WEB sections after the operator's global append-prompt file", async () => {
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Operator instructions.", "utf8");

    expect(await appendSystemPrompt(["<pi_web_docker_environment>\n- fact\n</pi_web_docker_environment>"])).toEqual([
      "Operator instructions.",
      "<pi_web_docker_environment>\n- fact\n</pi_web_docker_environment>",
    ]);
  });

  it("adds the sections when the operator has no append-prompt file", async () => {
    expect(await appendSystemPrompt(["deployment facts"])).toEqual(["deployment facts"]);
  });

  it("leaves the loader untouched when there are no sections", async () => {
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Operator instructions.", "utf8");

    expect(piWebResourceLoaderOptions([])).toBeUndefined();
    expect(await appendSystemPrompt([])).toEqual(["Operator instructions."]);
  });
});
