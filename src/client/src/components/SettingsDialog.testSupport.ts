import type { TemplateResult } from "lit";
import { vi } from "vitest";
import { PI_WEB_CAPABILITIES } from "../../../shared/capabilities";
import type { Machine, MachineRuntime, PiPackageInfo, PiPackageMutationResponse, PiWebConfigResponse, PiWebConfigValues, PiWebPluginInfo, PiWebPluginsResponse } from "../api";
import { SettingsDialog } from "./SettingsDialog";

export const remoteMachine: Machine = {
  id: "remote-a",
  name: "Lab Mac",
  kind: "remote",
  baseUrl: "https://lab.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

export const secondRemoteMachine: Machine = {
  id: "remote-b",
  name: "Build Box",
  kind: "remote",
  baseUrl: "https://build.example.test",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

export const runtimeWithPackageManagement: MachineRuntime = {
  machineId: "remote-a",
  ok: true,
  checkedAt: "2026-07-01T00:00:00.000Z",
  capabilities: [PI_WEB_CAPABILITIES.piPackagesManage],
};

export function getDialogProperty(dialog: SettingsDialog, property: string): unknown {
  return Reflect.get(dialog, property);
}

export function setDialogProperty(dialog: SettingsDialog, property: string, value: unknown): void {
  if (!Reflect.set(dialog, property, value)) throw new Error(`Failed to set SettingsDialog property ${property}`);
}

export async function callDialogPromise(dialog: SettingsDialog, methodName: string, ...args: readonly unknown[]): Promise<void> {
  const result = callDialogMethod(dialog, methodName, ...args);
  if (!(result instanceof Promise)) throw new Error(`SettingsDialog.${methodName} did not return a promise`);
  await result;
}

export function callDialogUpdated(dialog: SettingsDialog, changed: Map<string, unknown>): void {
  const result = callDialogMethod(dialog, "updated", changed);
  if (result !== undefined) throw new Error("SettingsDialog.updated returned an unexpected value");
}

function callDialogMethod(dialog: SettingsDialog, methodName: string, ...args: readonly unknown[]): unknown {
  const method: unknown = Reflect.get(dialog, methodName);
  if (!isDialogMethod(method)) throw new Error(`SettingsDialog.${methodName} is not callable`);
  return method.call(dialog, ...args);
}

function isDialogMethod(value: unknown): value is (this: SettingsDialog, ...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}

export function collectTemplateStrings(template: TemplateResult): string[] {
  const strings: string[] = [];
  visitTemplate(template);
  return strings;

  function visitTemplate(current: TemplateResult): void {
    strings.push(...templateStrings(current));
    for (const value of templateValues(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isTemplateResult(item)) visitTemplate(item);
      } else if (isTemplateResult(value)) {
        visitTemplate(value);
      }
    }
  }
}

function templateStrings(template: TemplateResult): readonly string[] {
  const strings = Reflect.get(template, "strings");
  if (!isStringArray(strings)) throw new Error("TemplateResult strings were unavailable");
  return strings;
}

function templateValues(template: TemplateResult): readonly unknown[] {
  const values = Reflect.get(template, "values");
  if (!Array.isArray(values)) throw new Error("TemplateResult values were unavailable");
  return values.map((value: unknown) => value);
}

function isTemplateResult(value: unknown): value is TemplateResult {
  return typeof value === "object" && value !== null && isStringArray(Reflect.get(value, "strings")) && Array.isArray(Reflect.get(value, "values"));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

export function configResponse(config: PiWebConfigValues): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config,
    effectiveConfig: config,
    envOverrides: { host: false, port: false, allowedHosts: false, spawnSessions: false, subsessions: false, agentCommand: false, agentDir: false, agentSessionDir: false },
  };
}

export function pluginsResponse(plugins: PiWebPluginInfo[]): PiWebPluginsResponse {
  return { plugins };
}

export function pluginInfo(id: string, enabled: boolean): PiWebPluginInfo {
  return {
    id,
    module: `/pi-web-plugins/${id}/plugin.js`,
    source: "test",
    scope: "local",
    machineSpecific: false,
    enabled,
  };
}

export function packageInfo(source: string): PiPackageInfo {
  return { source, scope: "user", filtered: false, installedPath: `/pi/packages/${source}` };
}

export function packageMutationResponse(action: PiPackageMutationResponse["action"], packages: PiPackageInfo[], source?: string): PiPackageMutationResponse {
  return source === undefined ? { action, packages } : { action, source, packages };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  let rejectDeferred: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  if (resolveDeferred === undefined || rejectDeferred === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

export function stubWindowTimers(): void {
  vi.stubGlobal("window", {
    clearTimeout: vi.fn(),
    setTimeout: vi.fn(() => 1),
  });
}
