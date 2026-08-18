/**
 * Container environment facts appended to the system prompt of sessions running
 * in a PI WEB Docker deployment.
 *
 * A Docker deployment changes what is true about the machine an agent works on:
 * commands run in a container instead of on the Docker host, most of the
 * filesystem is discarded on the next image build, and several host paths are
 * mounted in ways nothing in the working directory reveals. Agents otherwise
 * discover this by installing tools that vanish or by editing paths whose host
 * meaning they guessed wrong.
 *
 * The block states facts only: what the container is, which paths persist, and
 * where the durable extension points live. It deliberately gives no workflow
 * advice, so it does not compete with the operator's own `AGENTS.md`,
 * `SYSTEM.md`, or `APPEND_SYSTEM.md` content.
 *
 * Facts are derived from what the running container can observe — the mount
 * table plus the deployment descriptors Docker Compose already sets — rather
 * than from new environment variables. Agent processes inherit `PI_WEB_DOCKER_*`
 * and `HOSTEXEC_*` keys, and `pi-web-docker` resolves dev settings from its
 * ambient environment, so adding descriptor variables purely to describe the
 * deployment would risk changing what those tools do.
 */

import { readFileSync } from "node:fs";

/** One entry of the container's mount table, as far as facts need it. */
export interface ContainerMount {
  readonly target: string;
  readonly fsType: string;
  readonly readOnly: boolean;
}

export interface DockerEnvironmentFactsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly mounts: readonly ContainerMount[];
}

export interface DockerEnvironmentPromptOptions {
  readonly env: NodeJS.ProcessEnv;
  /** Operator switch, resolved from `environmentFacts` config plus its env override. */
  readonly enabled: boolean;
  readonly logger?: { warn: (details: Record<string, unknown>, message: string) => void };
  /** Seam for tests; defaults to reading the container's own mount table. */
  readonly readMountInfo?: () => string;
}

const MOUNT_INFO_PATH = "/proc/self/mountinfo";

/** Persistent PI WEB/Pi state mount, created by the Docker data bind mount. */
const DATA_MOUNT = "/data";
/** Read-only view of the Docker host root filesystem. */
const HOST_ROOT_MOUNT = "/host";
/** Development mode's bind mount of the PI WEB checkout. */
const DEV_WORKSPACE_MOUNT = "/workspace";
const DOCKER_SOCKET_MOUNTS = ["/run/docker.sock", "/var/run/docker.sock"] as const;

/**
 * Filesystem types that describe kernel or container-internal state rather than
 * a mounted host path. Host bind mounts report the underlying host filesystem
 * (`ext4`, `btrfs`, `xfs`, `zfs`, `nfs`, `virtiofs`, …), so excluding these
 * leaves the mounts an agent can meaningfully reason about.
 */
const CONTAINER_INTERNAL_FS_TYPES = new Set([
  "autofs",
  "binfmt_misc",
  "bpf",
  "cgroup",
  "cgroup2",
  "configfs",
  "debugfs",
  "devpts",
  "devtmpfs",
  "fusectl",
  "hugetlbfs",
  "mqueue",
  "nsfs",
  "overlay",
  "proc",
  "pstore",
  "ramfs",
  "securityfs",
  "selinuxfs",
  "shm",
  "sysfs",
  "tmpfs",
  "tracefs",
]);

/**
 * Mount targets that belong to the container runtime rather than to the
 * workspace surface: kernel filesystems plus the per-container files Docker
 * injects (`/etc/hosts`, `/etc/resolv.conf`, `/etc/hostname`) and the socket
 * paths reported separately below.
 */
const CONTAINER_INTERNAL_TARGET_ROOTS = ["/proc", "/sys", "/dev", "/etc", "/run", "/var/run", "/tmp"] as const;

/**
 * Read the container's mount table.
 *
 * Throws when the table cannot be read; the caller decides whether missing
 * facts should be reported or fatal.
 */
export function readContainerMounts(path: string = MOUNT_INFO_PATH): ContainerMount[] {
  return parseContainerMounts(readFileSync(path, "utf8"));
}

/**
 * Parse `/proc/self/mountinfo` content.
 *
 * Fields before the ` - ` separator are `id parent major:minor root mountPoint
 * options [optional fields]`; the separator is followed by `fsType source
 * superOptions`. Unparsable lines are skipped: a mount PI WEB cannot describe
 * simply produces no fact.
 */
export function parseContainerMounts(mountInfo: string): ContainerMount[] {
  const mounts: ContainerMount[] = [];
  for (const line of mountInfo.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    const head = line.slice(0, separator).split(" ");
    const target = head[4];
    const options = head[5];
    const fsType = line.slice(separator + 3).split(" ")[0];
    if (target === undefined || options === undefined || fsType === undefined || fsType === "") continue;
    mounts.push({
      target: unescapeMountField(target),
      fsType,
      readOnly: options.split(",").includes("ro"),
    });
  }
  return mounts;
}

/**
 * Build the environment facts block, or `undefined` when the process is not
 * running in a PI WEB Docker deployment.
 */
export function dockerEnvironmentFacts({ env, mounts }: DockerEnvironmentFactsInput): string | undefined {
  if (!isDockerDeployment(env)) return undefined;
  const devRepoRoot = nonEmptyEnv(env, "PI_WEB_DOCKER_DEV_REPO_ROOT");
  const installDir = nonEmptyEnv(env, "PI_WEB_DOCKER_INSTALL_DIR");
  const dockerCommand = devRepoRoot === undefined ? "pi-web-docker" : "pi-web-docker --dev";
  const imageHookDir = devRepoRoot === undefined
    ? `${installDir ?? "<install-dir>"}/custom-image.d/*.sh`
    : `${devRepoRoot}/docker/custom-image.d/*.sh`;
  const facts = [
    "Shell commands, file edits, and installed tools act inside the PI WEB container, not on the Docker host.",
    `The container filesystem is ephemeral: paths outside the mounts below are lost when the image is rebuilt or the containers are recreated (\`${dockerCommand} update\`).`,
    ...persistentDataFact(mounts, env),
    ...hostPathFacts(mounts),
    ...hostRootFact(mounts),
    ...dockerSocketFact(mounts),
    ...hostExecFact(env),
    ...devWorkspaceFacts(mounts, devRepoRoot),
    `Distro packages and global npm installs made during a session are part of that ephemeral layer. Image tooling comes from the \`PI_WEB_EXTRA_ZYPPER_PACKAGES\` build input and the build hooks in ${imageHookDir}.`,
  ];
  return [
    "<pi_web_docker_environment>",
    "Facts about the environment this session runs in:",
    ...facts.map((fact) => `- ${fact}`),
    "</pi_web_docker_environment>",
  ].join("\n");
}

/**
 * Resolve the system-prompt sections for this deployment.
 *
 * Returns an empty list outside Docker, when the operator switched the facts
 * off, or when the mount table cannot be read. A missing mount table is
 * reported through the logger rather than failing daemon startup: the facts
 * improve a prompt, and no session depends on them.
 */
export function dockerEnvironmentPromptSections(options: DockerEnvironmentPromptOptions): string[] {
  const { env, enabled, logger, readMountInfo } = options;
  if (!enabled || !isDockerDeployment(env)) return [];
  let mounts: readonly ContainerMount[];
  try {
    mounts = readMountInfo === undefined ? readContainerMounts() : parseContainerMounts(readMountInfo());
  } catch (error: unknown) {
    logger?.warn(
      { err: error, path: MOUNT_INFO_PATH },
      "could not read the container mount table; Docker environment facts are omitted from session system prompts",
    );
    return [];
  }
  const facts = dockerEnvironmentFacts({ env, mounts });
  return facts === undefined ? [] : [facts];
}

function isDockerDeployment(env: NodeJS.ProcessEnv): boolean {
  const value = env["PI_WEB_DOCKER_RUNTIME"];
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function persistentDataFact(mounts: readonly ContainerMount[], env: NodeJS.ProcessEnv): string[] {
  if (!mounts.some((mount) => mount.target === DATA_MOUNT)) return [];
  const home = nonEmptyEnv(env, "HOME");
  const configHome = nonEmptyEnv(env, "XDG_CONFIG_HOME");
  const agentDir = nonEmptyEnv(env, "PI_CODING_AGENT_DIR");
  const contents = [
    ...(home === undefined ? [] : [`\`HOME=${home}\``]),
    ...(configHome === undefined ? [] : [`\`XDG_CONFIG_HOME=${configHome}\``]),
    ...(agentDir === undefined ? [] : [`the agent profile directory \`${agentDir}\``]),
  ];
  const detail = contents.length === 0 ? "" : ` It holds ${contents.join(", ")}.`;
  return [`\`${DATA_MOUNT}\` is a persistent mount that survives image rebuilds.${detail}`];
}

function hostPathFacts(mounts: readonly ContainerMount[]): string[] {
  const paths = hostSharedMountTargets(mounts);
  if (paths.length === 0) return [];
  return [
    `Docker host paths mounted read/write at the same absolute path inside and outside the container: ${paths.map((path) => `\`${path}\``).join(", ")}.`,
  ];
}

/**
 * Host paths an agent can edit directly, deduplicated to their outermost mount
 * so a nested bind of an already-listed directory does not read as a second
 * location.
 */
function hostSharedMountTargets(mounts: readonly ContainerMount[]): string[] {
  const candidates = mounts
    .filter((mount) => !mount.readOnly && isHostPathMount(mount))
    .map((mount) => mount.target)
    .filter((target) => target !== DATA_MOUNT && target !== DEV_WORKSPACE_MOUNT && !isWithin(target, DEV_WORKSPACE_MOUNT))
    .sort((left, right) => left.localeCompare(right));
  return [...new Set(candidates)].filter((target, index, all) => !all.slice(0, index).some((outer) => isWithin(target, outer)));
}

function hostRootFact(mounts: readonly ContainerMount[]): string[] {
  const hostRoot = mounts.find((mount) => mount.target === HOST_ROOT_MOUNT);
  if (hostRoot === undefined) return [];
  return [
    `The Docker host root filesystem is mounted at \`${HOST_ROOT_MOUNT}\`${hostRoot.readOnly ? " read-only" : ""}.`,
  ];
}

function dockerSocketFact(mounts: readonly ContainerMount[]): string[] {
  const socket = DOCKER_SOCKET_MOUNTS.find((path) => mounts.some((mount) => mount.target === path));
  if (socket === undefined) return [];
  return ["The Docker socket is mounted, so `docker` commands act on the Docker host's daemon and containers."];
}

function hostExecFact(env: NodeJS.ProcessEnv): string[] {
  const mode = nonEmptyEnv(env, "HOSTEXEC_MODE");
  if (mode === undefined || mode === "disabled") {
    return ["`hostexec` is disabled in this deployment, so no command from this container runs on the Docker host."];
  }
  return ["`hostexec [--root] <command...>` runs a command on the Docker host, outside this container."];
}

function devWorkspaceFacts(mounts: readonly ContainerMount[], devRepoRoot: string | undefined): string[] {
  if (!mounts.some((mount) => mount.target === DEV_WORKSPACE_MOUNT)) return [];
  const hostPath = devRepoRoot === undefined ? "" : ` Its Docker host path is \`${devRepoRoot}\`.`;
  const nested = mounts
    .filter((mount) => mount.target !== DEV_WORKSPACE_MOUNT && isWithin(mount.target, DEV_WORKSPACE_MOUNT))
    .map((mount) => `\`${mount.target}\``);
  return [
    `The PI WEB checkout this deployment runs is bind-mounted at \`${DEV_WORKSPACE_MOUNT}\`.${hostPath}`,
    ...(nested.length === 0
      ? []
      : [`Inside it, ${nested.join(", ")} ${nested.length === 1 ? "is a separate container-managed mount" : "are separate container-managed mounts"}, not the host directory of the same path.`]),
  ];
}

function isHostPathMount(mount: ContainerMount): boolean {
  if (mount.target === "/" || !mount.target.startsWith("/")) return false;
  if (CONTAINER_INTERNAL_FS_TYPES.has(mount.fsType)) return false;
  return !CONTAINER_INTERNAL_TARGET_ROOTS.some((root) => mount.target === root || isWithin(mount.target, root));
}

function isWithin(target: string, root: string): boolean {
  return target.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Mount fields escape space, tab, newline, and backslash as octal sequences. */
function unescapeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === "" ? undefined : value;
}
