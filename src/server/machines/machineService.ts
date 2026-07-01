import type { Machine, MachineHealth, MachineRuntime, PiWebComponentStatus, PiWebRuntimeComponent, PiWebRuntimeResponse, PiWebStatusResponse } from "../../shared/apiTypes.js";
import { parsePiWebRuntimeResponse } from "../../shared/piWebStatusParsing.js";
import { getPiWebRuntime } from "../piWebStatus.js";
import { DEFAULT_REMOTE_HEALTH_TIMEOUT_MS, RemoteMachineClient, type MachineClient, validateConfiguredMachineHeaders } from "./machineClient.js";
import { MachineStore, type StoredMachine } from "./machineStore.js";

export interface CreateMachineInput {
  name?: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
}

export type UpdateMachineInput = Partial<CreateMachineInput>;

export interface MachineServiceDependencies {
  localRuntime?: () => Promise<PiWebRuntimeResponse>;
  remoteClientFactory?: (machine: StoredMachine) => MachineClient;
  now?: () => Date;
  healthCacheTtlMs?: number;
  runtimeCacheTtlMs?: number;
}

const LOCAL_MACHINE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const DEFAULT_HEALTH_CACHE_TTL_MS = 5_000;

export class MachineService {
  private readonly healthCache = new Map<string, { expiresAt: number; health: MachineHealth }>();
  private readonly runtimeCache = new Map<string, { expiresAt: number; runtime: MachineRuntime }>();

  constructor(private readonly store = new MachineStore(), private readonly deps: MachineServiceDependencies = {}) {}

  async list(): Promise<Machine[]> {
    return [localMachine(), ...(await this.store.list()).map(publicMachine)];
  }

  async get(id: string): Promise<Machine | undefined> {
    if (id === "local") return localMachine();
    const machine = (await this.store.list()).find((stored) => stored.id === id);
    return machine === undefined ? undefined : publicMachine(machine);
  }

  async add(input: CreateMachineInput): Promise<Machine> {
    const name = validateName(input.name);
    const baseUrl = validateBaseUrl(input.baseUrl);
    const stored = await this.store.add({ name, baseUrl, ...optionalSecrets(input) });
    return publicMachine(stored);
  }

  async update(id: string, input: UpdateMachineInput): Promise<Machine | undefined> {
    if (id === "local") throw new Error("Local machine cannot be changed");
    const patch: Partial<Pick<StoredMachine, "name" | "baseUrl" | "token" | "headers">> = {};
    if (input.name !== undefined) patch.name = validateName(input.name);
    if (input.baseUrl !== undefined) patch.baseUrl = validateBaseUrl(input.baseUrl);
    if (input.token !== undefined) patch.token = input.token;
    if (input.headers !== undefined) patch.headers = validateHeaders(input.headers);
    const stored = await this.store.update(id, patch);
    if (stored !== undefined) {
      this.healthCache.delete(id);
      this.runtimeCache.delete(id);
    }
    return stored === undefined ? undefined : publicMachine(stored);
  }

  async remove(id: string): Promise<boolean> {
    if (id === "local") throw new Error("Local machine cannot be deleted");
    const removed = await this.store.remove(id);
    if (removed) {
      this.healthCache.delete(id);
      this.runtimeCache.delete(id);
    }
    return removed;
  }

  async storedRemote(id: string): Promise<StoredMachine | undefined> {
    if (id === "local") return undefined;
    return (await this.store.list()).find((machine) => machine.id === id);
  }

  async remoteClient(id: string): Promise<MachineClient | undefined> {
    const machine = await this.storedRemote(id);
    return machine === undefined ? undefined : this.clientFor(machine);
  }

  async health(id: string): Promise<MachineHealth | undefined> {
    const cached = this.healthCache.get(id);
    const now = this.now().getTime();
    if (cached !== undefined && cached.expiresAt > now) return cached.health;

    const health = id === "local" ? await this.localHealth() : await this.remoteHealth(id);
    if (health === undefined) return undefined;
    this.healthCache.set(id, { expiresAt: now + (this.deps.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS), health });
    return health;
  }

  async runtime(id: string): Promise<MachineRuntime | undefined> {
    const cached = this.runtimeCache.get(id);
    const now = this.now().getTime();
    if (cached !== undefined && cached.expiresAt > now) return cached.runtime;

    const runtime = id === "local" ? await this.localRuntime() : await this.remoteRuntime(id);
    if (runtime === undefined) return undefined;
    this.runtimeCache.set(id, { expiresAt: now + (this.deps.runtimeCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS), runtime });
    return runtime;
  }

  private async localHealth(): Promise<MachineHealth> {
    const checkedAt = this.now().toISOString();
    try {
      const runtime = await (this.deps.localRuntime ?? getPiWebRuntime)();
      return {
        machineId: "local",
        ok: true,
        checkedAt,
        status: "online",
        web: componentStatusFromRuntime(runtime.components.web),
        sessiond: componentStatusFromRuntime(runtime.components.sessiond),
      };
    } catch (error) {
      return { machineId: "local", ok: false, checkedAt, status: "error", error: errorMessage(error) };
    }
  }

  private async remoteHealth(id: string): Promise<MachineHealth | undefined> {
    const machine = await this.storedRemote(id);
    if (machine === undefined) return undefined;
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.clientFor(machine).requestJson("GET", "/api/pi-web/status", undefined, { timeoutMs: DEFAULT_REMOTE_HEALTH_TIMEOUT_MS });
      if (response.statusCode >= 200 && response.statusCode < 300 && isPiWebStatusResponse(response.body)) {
        return { machineId: id, ok: true, checkedAt, status: "online", web: response.body.components.web, sessiond: response.body.components.sessiond };
      }
      return { machineId: id, ok: false, checkedAt, status: "error", error: `Remote health returned HTTP ${String(response.statusCode)}` };
    } catch (error) {
      return { machineId: id, ok: false, checkedAt, status: "offline", error: errorMessage(error) };
    }
  }

  private async localRuntime(): Promise<MachineRuntime> {
    const checkedAt = this.now().toISOString();
    try {
      return machineRuntime("local", checkedAt, await (this.deps.localRuntime ?? getPiWebRuntime)());
    } catch (error) {
      return { machineId: "local", ok: false, checkedAt, error: errorMessage(error) };
    }
  }

  private async remoteRuntime(id: string): Promise<MachineRuntime | undefined> {
    const machine = await this.storedRemote(id);
    if (machine === undefined) return undefined;
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.clientFor(machine).requestJson("GET", "/api/pi-web/runtime", undefined, { timeoutMs: DEFAULT_REMOTE_HEALTH_TIMEOUT_MS });
      const runtime = parsePiWebRuntimeResponse(response.body);
      if (response.statusCode >= 200 && response.statusCode < 300 && runtime !== undefined) return machineRuntime(id, checkedAt, runtime);
      return { machineId: id, ok: false, checkedAt, error: `Remote runtime returned HTTP ${String(response.statusCode)}` };
    } catch (error) {
      return { machineId: id, ok: false, checkedAt, error: errorMessage(error) };
    }
  }

  private clientFor(machine: StoredMachine): MachineClient {
    return this.deps.remoteClientFactory?.(machine) ?? new RemoteMachineClient(machine);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

export function localMachine(): Machine {
  return { id: "local", name: "Local", kind: "local", createdAt: LOCAL_MACHINE_TIMESTAMP, updatedAt: LOCAL_MACHINE_TIMESTAMP };
}

function publicMachine(machine: StoredMachine): Machine {
  return { id: machine.id, name: machine.name, kind: "remote", baseUrl: machine.baseUrl, createdAt: machine.createdAt, updatedAt: machine.updatedAt };
}

function validateName(value: string | undefined): string {
  const name = value?.trim();
  if (name === undefined || name === "") throw new Error("Machine name is required");
  return name;
}

function validateBaseUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (raw === undefined || raw === "") throw new Error("Machine baseUrl is required");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Machine baseUrl must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Machine baseUrl must use http or https");
  if (url.username !== "" || url.password !== "") throw new Error("Machine baseUrl must not include credentials");
  if (url.search !== "" || url.hash !== "") throw new Error("Machine baseUrl must not include query or hash");
  return url.href.replace(/\/$/u, "");
}

function optionalSecrets(input: CreateMachineInput): { token?: string; headers?: Record<string, string> } {
  return {
    ...(input.token === undefined ? {} : { token: input.token }),
    ...(input.headers === undefined ? {} : { headers: validateHeaders(input.headers) }),
  };
}

function validateHeaders(value: Record<string, string>): Record<string, string> {
  return validateConfiguredMachineHeaders(value) ?? {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function componentStatusFromRuntime(runtime: PiWebRuntimeComponent): PiWebComponentStatus {
  return {
    component: runtime.component,
    label: runtime.label,
    ...(runtime.runtimeVersion === undefined ? {} : { runtimeVersion: runtime.runtimeVersion }),
    stale: false,
    available: runtime.available,
    ...(runtime.error === undefined ? {} : { error: runtime.error }),
  };
}

function machineRuntime(machineId: string, checkedAt: string, runtime: PiWebRuntimeResponse): MachineRuntime {
  return {
    machineId,
    ok: true,
    checkedAt,
    packageName: runtime.packageName,
    generatedAt: runtime.generatedAt,
    components: runtime.components,
    capabilities: runtime.capabilities,
  };
}

function isPiWebStatusResponse(value: unknown): value is PiWebStatusResponse {
  if (!isRecord(value)) return false;
  const components = value["components"];
  if (!isRecord(components)) return false;
  return isPiWebComponentStatus(components["web"]) && isPiWebComponentStatus(components["sessiond"]);
}

function isPiWebComponentStatus(value: unknown): value is PiWebComponentStatus {
  if (!isRecord(value)) return false;
  const component = value["component"];
  return (component === "web" || component === "sessiond")
    && typeof value["label"] === "string"
    && typeof value["stale"] === "boolean"
    && typeof value["available"] === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
