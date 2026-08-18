import { describe, expect, it } from "vitest";
import { dockerEnvironmentFacts, dockerEnvironmentPromptSections, parseContainerMounts, type ContainerMount } from "./dockerEnvironmentFacts.js";

/**
 * A mount table shaped like the real one a PI WEB Docker container reports:
 * kernel filesystems, Docker's per-container `/etc` files, the data mount, host
 * bind mounts (including a nested duplicate of one), the read-only host root,
 * the Docker socket, and the dev checkout with its dependency volume.
 */
const MOUNT_INFO = [
  "1 0 0:1 / / rw,relatime - overlay overlay rw,lowerdir=/x,upperdir=/y",
  "2 1 0:2 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw",
  "3 1 0:3 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro,seclabel",
  "4 1 0:4 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k",
  "5 1 8:9 /opt /opt rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "6 1 8:9 /home /home rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "7 1 8:9 /srv /srv rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "8 1 8:9 /data /data rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "9 1 8:9 /repo /workspace rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "10 9 8:9 /volumes/node_modules /workspace/node_modules rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "11 1 8:9 /etc/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "12 1 8:9 /docker.sock /run/docker.sock rw,nosuid,nodev - tmpfs tmpfs rw,mode=755",
  "13 1 8:9 /home/dev/checkout /home/dev/checkout rw,relatime - ext4 /dev/sda9 rw,seclabel",
  "14 1 0:5 / /host ro,relatime - btrfs /dev/sda9 rw,seclabel",
  "",
].join("\n");

const RUNTIME_ENV: NodeJS.ProcessEnv = {
  PI_WEB_DOCKER_RUNTIME: "1",
  PI_WEB_DOCKER_MODE: "runtime",
  PI_WEB_DOCKER_INSTALL_DIR: "/home/user/.local/share/pi-web-docker",
  HOSTEXEC_MODE: "nsenter",
  HOME: "/data/home",
  XDG_CONFIG_HOME: "/data/config",
  PI_CODING_AGENT_DIR: "/data/pi-agent",
};

const DEV_ENV: NodeJS.ProcessEnv = {
  ...RUNTIME_ENV,
  PI_WEB_DOCKER_MODE: "dev",
  PI_WEB_DOCKER_DEV_REPO_ROOT: "/home/user/projects/pi-web",
};

function mounts(): ContainerMount[] {
  return parseContainerMounts(MOUNT_INFO);
}

function factsFor(env: NodeJS.ProcessEnv): string {
  const facts = dockerEnvironmentFacts({ env, mounts: mounts() });
  if (facts === undefined) throw new Error("expected environment facts for a Docker deployment");
  return facts;
}

describe("parseContainerMounts", () => {
  it("reads mount target, filesystem type, and read-only state", () => {
    expect(mounts()).toContainEqual({ target: "/host", fsType: "btrfs", readOnly: true });
    expect(mounts()).toContainEqual({ target: "/data", fsType: "ext4", readOnly: false });
    expect(mounts()).toContainEqual({ target: "/proc", fsType: "proc", readOnly: false });
  });

  it("unescapes octal sequences in mount targets and skips unparsable lines", () => {
    const parsed = parseContainerMounts([
      "1 0 8:9 / /host\\040paths rw,relatime - ext4 /dev/sda9 rw",
      "not a mountinfo line",
      "",
    ].join("\n"));

    expect(parsed).toEqual([{ target: "/host paths", fsType: "ext4", readOnly: false }]);
  });
});

describe("dockerEnvironmentFacts", () => {
  it("adds nothing outside a Docker deployment", () => {
    expect(dockerEnvironmentFacts({ env: {}, mounts: mounts() })).toBeUndefined();
    expect(dockerEnvironmentFacts({ env: { PI_WEB_DOCKER_RUNTIME: "0" }, mounts: mounts() })).toBeUndefined();
  });

  it("states that work happens in the container and that its filesystem is ephemeral", () => {
    const facts = factsFor(RUNTIME_ENV);

    expect(facts).toContain("act inside the PI WEB container, not on the Docker host");
    expect(facts).toContain("The container filesystem is ephemeral");
    expect(facts).toContain("`pi-web-docker update`");
  });

  it("names the persistent data mount and what it holds", () => {
    expect(factsFor(RUNTIME_ENV)).toContain(
      "`/data` is a persistent mount that survives image rebuilds. It holds `HOME=/data/home`, `XDG_CONFIG_HOME=/data/config`, the agent profile directory `/data/pi-agent`.",
    );
  });

  it("lists writable host paths by their outermost mount only", () => {
    const facts = factsFor(RUNTIME_ENV);

    expect(facts).toContain("mounted read/write at the same absolute path inside and outside the container: `/home`, `/opt`, `/srv`.");
    // /home/dev/checkout is a nested bind of an already-listed host path, and
    // /etc, /run, and /workspace mounts are not agent-facing host paths.
    expect(facts).not.toContain("/home/dev/checkout");
    expect(facts).not.toContain("/etc/resolv.conf");
  });

  it("reports the read-only host root and the mounted Docker socket", () => {
    const facts = factsFor(RUNTIME_ENV);

    expect(facts).toContain("The Docker host root filesystem is mounted at `/host` read-only.");
    expect(facts).toContain("The Docker socket is mounted");
  });

  it("describes hostexec according to the deployment's mode", () => {
    expect(factsFor(RUNTIME_ENV)).toContain("`hostexec [--root] <command...>` runs a command on the Docker host");
    expect(factsFor({ ...RUNTIME_ENV, HOSTEXEC_MODE: "disabled" })).toContain("`hostexec` is disabled in this deployment");
  });

  it("points runtime deployments at their own image extension points", () => {
    expect(factsFor(RUNTIME_ENV)).toContain(
      "the build hooks in /home/user/.local/share/pi-web-docker/custom-image.d/*.sh",
    );
  });

  it("describes the dev checkout mount, its host path, and its nested volume", () => {
    const facts = factsFor(DEV_ENV);

    expect(facts).toContain("bind-mounted at `/workspace`. Its Docker host path is `/home/user/projects/pi-web`.");
    expect(facts).toContain("`/workspace/node_modules` is a separate container-managed mount");
    expect(facts).toContain("`pi-web-docker --dev update`");
    expect(facts).toContain("the build hooks in /home/user/projects/pi-web/docker/custom-image.d/*.sh");
  });

  it("omits facts for absent mounts", () => {
    const facts = dockerEnvironmentFacts({
      env: RUNTIME_ENV,
      mounts: [{ target: "/data", fsType: "ext4", readOnly: false }],
    });

    expect(facts).toContain("`/data` is a persistent mount");
    expect(facts).not.toContain("/host");
    expect(facts).not.toContain("Docker socket is mounted");
    expect(facts).not.toContain("/workspace");
  });

  it("wraps the facts in one tagged block of plain statements", () => {
    const facts = factsFor(RUNTIME_ENV);
    const lines = facts.split("\n");

    expect(lines[0]).toBe("<pi_web_docker_environment>");
    expect(lines.at(-1)).toBe("</pi_web_docker_environment>");
    expect(lines.slice(2, -1).every((line) => line.startsWith("- "))).toBe(true);
  });
});

describe("dockerEnvironmentPromptSections", () => {
  it("returns one section for an enabled Docker deployment", () => {
    const sections = dockerEnvironmentPromptSections({
      env: RUNTIME_ENV,
      enabled: true,
      readMountInfo: () => MOUNT_INFO,
    });

    expect(sections).toEqual([factsFor(RUNTIME_ENV)]);
  });

  it("returns nothing when the operator switched the facts off", () => {
    expect(dockerEnvironmentPromptSections({
      env: RUNTIME_ENV,
      enabled: false,
      readMountInfo: () => MOUNT_INFO,
    })).toEqual([]);
  });

  it("returns nothing outside a Docker deployment without reading the mount table", () => {
    let reads = 0;

    const sections = dockerEnvironmentPromptSections({
      env: {},
      enabled: true,
      readMountInfo: () => {
        reads += 1;
        return MOUNT_INFO;
      },
    });

    expect(sections).toEqual([]);
    expect(reads).toBe(0);
  });

  it("warns and omits the facts when the mount table cannot be read", () => {
    const warnings: string[] = [];

    const sections = dockerEnvironmentPromptSections({
      env: RUNTIME_ENV,
      enabled: true,
      logger: { warn: (_details, message) => { warnings.push(message); } },
      readMountInfo: () => { throw new Error("EACCES"); },
    });

    expect(sections).toEqual([]);
    expect(warnings).toEqual([
      "could not read the container mount table; Docker environment facts are omitted from session system prompts",
    ]);
  });
});
