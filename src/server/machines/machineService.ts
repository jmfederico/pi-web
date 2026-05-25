import type { Machine } from "../../shared/apiTypes.js";
import { MachineStore, type StoredMachine } from "./machineStore.js";

export interface CreateMachineInput {
  name?: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
}

export type UpdateMachineInput = Partial<CreateMachineInput>;

const LOCAL_MACHINE_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export class MachineService {
  constructor(private readonly store = new MachineStore()) {}

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
    return stored === undefined ? undefined : publicMachine(stored);
  }

  async remove(id: string): Promise<boolean> {
    if (id === "local") throw new Error("Local machine cannot be deleted");
    return await this.store.remove(id);
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
  return Object.fromEntries(Object.entries(value).map(([key, headerValue]) => {
    if (typeof headerValue !== "string") throw new Error("Machine headers must be strings");
    return [key, headerValue];
  }));
}
