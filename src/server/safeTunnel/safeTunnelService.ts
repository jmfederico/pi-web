import { isAbsolute } from "node:path";
import {
  SafeTunnelControlPlaneError,
  safeTunnelClientVersion,
  type SafeTunnelApprovedDeviceAuthorization,
  type SafeTunnelControlPlane,
  type SafeTunnelDeviceAuthorization,
  type SafeTunnelDeviceAuthorizationCompletion,
  type SafeTunnelHeartbeatTunnelStatus,
  type SafeTunnelMachineHeartbeat,
  type SafeTunnelMachineTunnelConfig,
  type SafeTunnelRegisteredMachine,
} from "./safeTunnelControlPlane.js";
import { prepareSafeTunnelFrpcConfig } from "./safeTunnelFrpcConfig.js";
import { safeTunnelFrpcTrustedCaPath } from "./safeTunnelFrpcRuntimeFiles.js";
import {
  normalizeSafeTunnelControlApiBaseUrl,
  normalizeSafeTunnelLocalPiWebUrl,
  normalizeSafeTunnelPublicUrl,
  requireSafeTunnelBearerCredential,
  type LoadedSafeTunnelState,
  type SafeTunnelMachineCredentials,
  type SafeTunnelPersistedState,
  type SafeTunnelStateStorage,
} from "./safeTunnelState.js";

export type SafeTunnelServiceErrorCode =
  | "authorization_expired"
  | "credentials_rejected"
  | "invalid_heartbeat"
  | "invalid_login"
  | "invalid_tunnel_config"
  | "not_registered";

export class SafeTunnelServiceError extends Error {
  constructor(readonly code: SafeTunnelServiceErrorCode) {
    super(safeTunnelServiceErrorMessage(code));
  }
}

export interface SafeTunnelLoginInput {
  readonly controlApiBaseUrl: string;
  readonly machineName: string;
  readonly machineSlug: string;
  readonly localPiWebUrl?: string;
  readonly frpcPath?: string;
}

export interface SafeTunnelEnableInput {
  readonly frpcPath?: string;
  readonly localPiWebUrl?: string;
}

export type SafeTunnelPublicDeviceAuthorization = Omit<
  SafeTunnelDeviceAuthorization,
  "deviceCode"
>;

export interface SafeTunnelLoginObserver {
  readonly onAuthorizationApproved?: () => void;
  readonly onDeviceAuthorization?: (
    authorization: SafeTunnelPublicDeviceAuthorization,
  ) => void;
  readonly onMachineRegistered?: () => void;
}

export interface SafeTunnelLoginOptions {
  readonly signal?: AbortSignal;
}

export interface SafeTunnelLoginResult {
  readonly machineCredentials: SafeTunnelMachineCredentials;
  readonly registeredMachine: SafeTunnelRegisteredMachine;
}

export interface SafeTunnelPreparedTunnelConfig extends SafeTunnelMachineTunnelConfig {
  readonly localPiWebUrl: string;
  readonly frpcConfigToml: string;
  /**
   * Persisted machine credential the prepared TOML must carry as global
   * machine metadata. Server-internal operation memory only: never returned
   * to the browser or logged.
   */
  readonly machineToken: string;
}

export interface SafeTunnelServiceDependencies {
  readonly controlPlane: SafeTunnelControlPlane;
  readonly stateStorage: SafeTunnelStateStorage;
  readonly frpcTrustedCaPath?: string;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Coordinates durable local intent and credentials with the normalized Control
 * API contract. Browser shaping and child-process ownership live elsewhere.
 */
export class SafeTunnelService {
  private readonly frpcTrustedCaPath: string;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: SafeTunnelServiceDependencies) {
    this.frpcTrustedCaPath = dependencies.frpcTrustedCaPath
      ?? safeTunnelFrpcTrustedCaPath(dependencies.stateStorage.filePath);
    this.now = dependencies.now ?? (() => new Date());
    this.sleep = dependencies.sleep ?? abortableSleep;
  }

  get statePath(): string {
    return this.dependencies.stateStorage.filePath;
  }

  async state(): Promise<LoadedSafeTunnelState> {
    await this.mutationTail;
    return this.dependencies.stateStorage.load();
  }

  async login(
    input: SafeTunnelLoginInput,
    observer: SafeTunnelLoginObserver = {},
    options: SafeTunnelLoginOptions = {},
  ): Promise<SafeTunnelLoginResult> {
    throwIfAborted(options.signal);
    const existing = await this.state();
    const login = normalizeLoginInput(input, existing.state);

    const started = validateDeviceAuthorization(
      await this.dependencies.controlPlane.startDeviceAuthorization({
        controlApiBaseUrl: login.controlApiBaseUrl,
        clientVersion: safeTunnelClientVersion,
      }, options.signal === undefined ? {} : { signal: options.signal }),
    );
    throwIfAborted(options.signal);
    observer.onDeviceAuthorization?.({
      userCode: started.userCode,
      verificationUri: started.verificationUri,
      verificationUriComplete: started.verificationUriComplete,
      expiresAt: started.expiresAt,
      intervalSeconds: started.intervalSeconds,
    });

    const authorization = await this.waitForApproval(
      login.controlApiBaseUrl,
      started,
      options.signal,
    );
    throwIfAborted(options.signal);
    const connectorAccessToken = requireSafeTunnelBearerCredential(
      authorization.accessToken,
      "accessToken",
    );
    observer.onAuthorizationApproved?.();

    // Once registration begins, let its one-time credential response finish and
    // persist even if the user disables concurrently; the bridge checks
    // cancellation before it can arm supervision.
    const registeredMachine = normalizeRegisteredPublicIngress(
      await this.dependencies.controlPlane.registerMachine({
        controlApiBaseUrl: login.controlApiBaseUrl,
        connectorAccessToken,
        machineName: login.machineName,
        machineSlug: login.machineSlug,
        localPiWebUrl: login.localPiWebUrl,
        clientVersion: safeTunnelClientVersion,
      }),
    );
    // The registered machine must belong to the account that approved this
    // device authorization; a mismatch is invalid provider output, not an
    // account selection.
    if (registeredMachine.machine.accountId !== authorization.account.id) {
      throw new SafeTunnelServiceError("invalid_login");
    }
    if (registeredMachine.machine.slug !== login.machineSlug) {
      throw new SafeTunnelServiceError("invalid_login");
    }
    const machineToken = requireSafeTunnelBearerCredential(
      registeredMachine.machineToken,
      "machineToken",
    );
    const machineCredentials: SafeTunnelMachineCredentials = {
      controlApiBaseUrl: login.controlApiBaseUrl,
      credentialStatus: "active",
      machineId: registeredMachine.machine.id,
      machineToken,
      machineSlug: registeredMachine.machine.slug,
      publicUrl: registeredMachine.publicUrl,
    };

    await this.mutateState((current) => ({
      ...current,
      localPiWebUrl: login.localPiWebUrl,
      machine: machineCredentials,
      ...(login.frpcPath === undefined ? {} : { frpcPath: login.frpcPath }),
    }));
    observer.onMachineRegistered?.();

    return { machineCredentials, registeredMachine };
  }

  async enable(
    input: SafeTunnelEnableInput = {},
  ): Promise<SafeTunnelPersistedState> {
    const normalizedFrpcPath = input.frpcPath === undefined
      ? undefined
      : requireAbsoluteFrpcPath(input.frpcPath);
    let normalizedLocalPiWebUrl: string | undefined;
    try {
      normalizedLocalPiWebUrl = input.localPiWebUrl === undefined
        ? undefined
        : normalizeSafeTunnelLocalPiWebUrl(input.localPiWebUrl);
    } catch {
      throw new SafeTunnelServiceError("invalid_login");
    }

    return this.mutateState((current) => {
      const machine = current.machine;
      if (machine === undefined) throw new SafeTunnelServiceError("not_registered");
      if (machine.credentialStatus === "rejected") {
        throw new SafeTunnelServiceError("credentials_rejected");
      }
      return {
        ...current,
        desiredState: "enabled",
        ...(normalizedLocalPiWebUrl === undefined ? {} : { localPiWebUrl: normalizedLocalPiWebUrl }),
        ...(normalizedFrpcPath === undefined ? {} : { frpcPath: normalizedFrpcPath }),
      };
    });
  }

  disable(): Promise<SafeTunnelPersistedState> {
    return this.mutateState((current) => ({ ...current, desiredState: "disabled" }));
  }

  async getTunnelConfig(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SafeTunnelPreparedTunnelConfig> {
    const loaded = await this.state();
    const credentials = loaded.state.machine;
    if (credentials === undefined) throw new SafeTunnelServiceError("not_registered");
    if (credentials.credentialStatus === "rejected") {
      throw new SafeTunnelServiceError("credentials_rejected");
    }

    let tunnelConfig: SafeTunnelMachineTunnelConfig;
    try {
      tunnelConfig = await this.dependencies.controlPlane.getMachineTunnelConfig(
        credentials,
        options,
      );
    } catch (error: unknown) {
      await this.rememberRejectedCredentials(credentials, error).catch(() => undefined);
      throw error;
    }
    if (tunnelConfig.machineId !== credentials.machineId
      || !matchesRegisteredPublicIngress(tunnelConfig, credentials.publicUrl)) {
      throw new SafeTunnelServiceError("invalid_tunnel_config");
    }
    return applySafeTunnelLocalTarget(
      tunnelConfig,
      loaded.state.localPiWebUrl,
      this.frpcTrustedCaPath,
      credentials.machineToken,
    );
  }

  async recordHeartbeat(
    input: {
      readonly tunnelStatus: SafeTunnelHeartbeatTunnelStatus;
      readonly errorMessage?: string;
    },
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SafeTunnelMachineHeartbeat> {
    const loaded = await this.state();
    const credentials = loaded.state.machine;
    if (credentials === undefined) throw new SafeTunnelServiceError("not_registered");
    if (credentials.credentialStatus === "rejected") {
      throw new SafeTunnelServiceError("credentials_rejected");
    }

    let heartbeat: SafeTunnelMachineHeartbeat;
    try {
      heartbeat = await this.dependencies.controlPlane.recordMachineHeartbeat(
        credentials,
        {
          clientVersion: safeTunnelClientVersion,
          tunnelStatus: input.tunnelStatus,
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        },
        options,
      );
    } catch (error: unknown) {
      await this.rememberRejectedCredentials(credentials, error).catch(() => undefined);
      throw error;
    }
    if (heartbeat.machineId !== credentials.machineId) {
      throw new SafeTunnelServiceError("invalid_heartbeat");
    }
    return heartbeat;
  }

  private async waitForApproval(
    controlApiBaseUrl: string,
    started: SafeTunnelDeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<SafeTunnelApprovedDeviceAuthorization> {
    const expiresAtMilliseconds = Date.parse(started.expiresAt);
    // The hosted cadence baseline starts at authorization creation, so the
    // first completion request must also wait one full interval.
    let delaySeconds = started.intervalSeconds;

    for (;;) {
      await this.waitForNextPoll(delaySeconds, expiresAtMilliseconds, signal);

      let completion: SafeTunnelDeviceAuthorizationCompletion;
      try {
        completion = await this.dependencies.controlPlane.completeDeviceAuthorization({
          controlApiBaseUrl,
          deviceCode: started.deviceCode,
        }, signal === undefined ? {} : { signal });
      } catch (error: unknown) {
        // A bounded hosted rate limit is retryable backpressure: honor its
        // Retry-After rather than failing the approval flow or busy-looping.
        if (error instanceof SafeTunnelControlPlaneError
          && error.code === "rate_limited"
          && error.retryAfterSeconds !== undefined) {
          delaySeconds = error.retryAfterSeconds;
          continue;
        }
        throw error;
      }
      throwIfAborted(signal);
      if (completion.kind === "approved") return completion.authorization;

      // A rejected early poll does not advance the hosted cadence baseline, so
      // its Retry-After is the authoritative delay; pending polls resume the
      // plain interval cadence.
      delaySeconds = completion.kind === "slow_down"
        ? completion.retryAfterSeconds
        : started.intervalSeconds;
    }
  }

  private async waitForNextPoll(
    delaySeconds: number,
    expiresAtMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const remainingMilliseconds = expiresAtMilliseconds - this.now().getTime();
    if (remainingMilliseconds <= 0) {
      throw new SafeTunnelServiceError("authorization_expired");
    }
    await this.sleep(
      Math.min(delaySeconds * 1000, remainingMilliseconds),
      signal,
    );
    // Never send a completion request for an expired device code.
    throwIfAborted(signal);
    if (expiresAtMilliseconds <= this.now().getTime()) {
      throw new SafeTunnelServiceError("authorization_expired");
    }
  }

  private async rememberRejectedCredentials(
    credentials: SafeTunnelMachineCredentials,
    error: unknown,
  ): Promise<void> {
    if (!(error instanceof SafeTunnelControlPlaneError)
      || error.code !== "authentication_failed") return;

    await this.mutateState((current) => {
      const currentMachine = current.machine;
      if (currentMachine?.machineId !== credentials.machineId
        || currentMachine.machineToken !== credentials.machineToken
        || currentMachine.credentialStatus === "rejected") return current;
      return {
        ...current,
        machine: { ...currentMachine, credentialStatus: "rejected" },
      };
    });
  }

  private mutateState(
    update: (current: SafeTunnelPersistedState) => SafeTunnelPersistedState,
  ): Promise<SafeTunnelPersistedState> {
    const mutation = this.mutationTail.then(async () => {
      const loaded = await this.dependencies.stateStorage.load();
      const next = update(loaded.state);
      if (next !== loaded.state) await this.dependencies.stateStorage.save(next);
      return next;
    });
    this.mutationTail = mutation.then(() => undefined, () => undefined);
    return mutation;
  }
}

function normalizeRegisteredPublicIngress(
  registeredMachine: SafeTunnelRegisteredMachine,
): SafeTunnelRegisteredMachine {
  let publicUrl: string;
  try {
    publicUrl = normalizeSafeTunnelPublicUrl(registeredMachine.publicUrl);
  } catch {
    throw new SafeTunnelServiceError("invalid_login");
  }
  if (new URL(publicUrl).hostname !== registeredMachine.publicHostname) {
    throw new SafeTunnelServiceError("invalid_login");
  }
  return { ...registeredMachine, publicUrl };
}

function matchesRegisteredPublicIngress(
  tunnelConfig: SafeTunnelMachineTunnelConfig,
  registeredPublicUrl: string | undefined,
): boolean {
  if (registeredPublicUrl === undefined) return false;
  try {
    const registeredOrigin = normalizeSafeTunnelPublicUrl(registeredPublicUrl);
    const configuredOrigin = normalizeSafeTunnelPublicUrl(tunnelConfig.publicUrl);
    return configuredOrigin === registeredOrigin
      && tunnelConfig.publicHostname === new URL(registeredOrigin).hostname;
  } catch {
    return false;
  }
}

interface NormalizedSafeTunnelLoginInput {
  readonly controlApiBaseUrl: string;
  readonly machineName: string;
  readonly machineSlug: string;
  readonly localPiWebUrl: string;
  readonly frpcPath?: string;
}

function normalizeLoginInput(
  input: SafeTunnelLoginInput,
  existing: SafeTunnelPersistedState,
): NormalizedSafeTunnelLoginInput {
  let controlApiBaseUrl: string;
  let localPiWebUrl: string;
  try {
    controlApiBaseUrl = normalizeSafeTunnelControlApiBaseUrl(input.controlApiBaseUrl);
    localPiWebUrl = normalizeSafeTunnelLocalPiWebUrl(
      input.localPiWebUrl ?? existing.localPiWebUrl,
    );
  } catch {
    throw new SafeTunnelServiceError("invalid_login");
  }

  const machineName = requireNonEmptyString(input.machineName);
  if (machineName.length > 80) throw new SafeTunnelServiceError("invalid_login");
  const machineSlug = requireNonEmptyString(input.machineSlug);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(machineSlug)) {
    throw new SafeTunnelServiceError("invalid_login");
  }
  const frpcPath = input.frpcPath === undefined
    ? undefined
    : requireAbsoluteFrpcPath(input.frpcPath);

  return {
    controlApiBaseUrl,
    machineName,
    machineSlug,
    localPiWebUrl,
    ...(frpcPath === undefined ? {} : { frpcPath }),
  };
}

export function applySafeTunnelLocalTarget(
  tunnelConfig: SafeTunnelMachineTunnelConfig,
  localPiWebUrl: string,
  frpcTrustedCaPath: string,
  machineToken: string,
): SafeTunnelPreparedTunnelConfig {
  try {
    const normalizedLocalPiWebUrl = normalizeSafeTunnelLocalPiWebUrl(localPiWebUrl);
    const frpcConfigToml = prepareSafeTunnelFrpcConfig(
      tunnelConfig,
      normalizedLocalPiWebUrl,
      { trustedCaFile: frpcTrustedCaPath, machineToken },
    );
    return {
      ...tunnelConfig,
      localPiWebUrl: normalizedLocalPiWebUrl,
      frpcConfigToml,
      machineToken,
    };
  } catch {
    throw new SafeTunnelServiceError("invalid_tunnel_config");
  }
}

function validateDeviceAuthorization(
  authorization: SafeTunnelDeviceAuthorization,
): SafeTunnelDeviceAuthorization {
  const deviceCode = authorization.deviceCode;
  if (deviceCode === ""
    || deviceCode.length > 4_096
    || hasTerminalControl(deviceCode)) {
    throw new SafeTunnelServiceError("invalid_login");
  }
  return authorization;
}

function hasTerminalControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined
      || codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function requireNonEmptyString(value: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new SafeTunnelServiceError("invalid_login");
  return normalized;
}

function requireAbsoluteFrpcPath(value: string): string {
  const normalized = requireNonEmptyString(value);
  if (!isAbsolute(normalized)) throw new SafeTunnelServiceError("invalid_login");
  return normalized;
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Safe Tunnel enablement was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Safe Tunnel enablement was cancelled.");
}

function safeTunnelServiceErrorMessage(code: SafeTunnelServiceErrorCode): string {
  switch (code) {
    case "authorization_expired":
      return "Safe Tunnel device authorization expired before approval.";
    case "credentials_rejected":
      return "Safe Tunnel machine credentials were rejected or revoked.";
    case "invalid_heartbeat":
      return "The Safe Tunnel service returned a heartbeat for an unexpected machine.";
    case "invalid_login":
      return "Safe Tunnel login settings are invalid.";
    case "invalid_tunnel_config":
      return "The Safe Tunnel service returned configuration for an unexpected local target.";
    case "not_registered":
      return "Register or log in to PI WEB Safe Tunnels first.";
  }
}
