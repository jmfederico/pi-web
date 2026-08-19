import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  DefaultSafeTunnelBridgeService,
  type SafeTunnelBridgeService,
} from "./safeTunnelBridgeService.js";
import { HttpSafeTunnelControlPlane } from "./safeTunnelControlPlane.js";
import {
  createNodeSafeTunnelEnableDefaultsProvider,
  type SafeTunnelServerAddress,
} from "./safeTunnelEnableDefaults.js";
import {
  defaultSafeTunnelFrpcInstallDirectory,
  FileSafeTunnelFrpcInstallationStore,
  HttpSafeTunnelFrpcArtifactSource,
  SafeTunnelFrpcManager,
  TarGzipSafeTunnelFrpcArchiveExtractor,
} from "./safeTunnelFrpcManager.js";
import { NodeSafeTunnelFrpcProcessLauncher } from "./safeTunnelFrpcProcess.js";
import { FileSafeTunnelFrpcRuntimeFiles } from "./safeTunnelFrpcRuntimeFiles.js";
import {
  NodeSafeTunnelSupervisorClock,
  SafeTunnelFrpcSupervisor,
} from "./safeTunnelFrpcSupervisor.js";
import { SafeTunnelRuntimeReconciler } from "./safeTunnelRuntimeReconciler.js";
import { SafeTunnelService } from "./safeTunnelService.js";
import {
  defaultSafeTunnelStatePath,
  FileSafeTunnelStateStorage,
} from "./safeTunnelState.js";

export interface SafeTunnelProductionOptions {
  readonly serverAddress: () => SafeTunnelServerAddress;
}

/** Constructs the effectful Safe Tunnel graph only after global opt-in. */
export function createSafeTunnelProduction(
  options: SafeTunnelProductionOptions,
): SafeTunnelBridgeService {
  const statePath = defaultSafeTunnelStatePath();
  const runtimeFiles = new FileSafeTunnelFrpcRuntimeFiles({ statePath });
  const safeTunnel = new SafeTunnelService({
    controlPlane: new HttpSafeTunnelControlPlane(),
    frpcTrustedCaPath: runtimeFiles.trustedCaPath,
    stateStorage: new FileSafeTunnelStateStorage({ filePath: statePath }),
  });
  const managedFrpc = new SafeTunnelFrpcManager({
    archiveExtractor: new TarGzipSafeTunnelFrpcArchiveExtractor(),
    artifactSource: new HttpSafeTunnelFrpcArtifactSource(),
    installationStore: new FileSafeTunnelFrpcInstallationStore({
      installDirectory: defaultSafeTunnelFrpcInstallDirectory(statePath),
    }),
  });
  const clock = new NodeSafeTunnelSupervisorClock();
  const supervisor = new SafeTunnelFrpcSupervisor({
    clock,
    configProvider: safeTunnel,
    files: runtimeFiles,
    launcher: new NodeSafeTunnelFrpcProcessLauncher(),
    managedFrpc,
  });
  const runtime = new SafeTunnelRuntimeReconciler({
    clock,
    runtime: supervisor,
    safeTunnel,
  });

  return new DefaultSafeTunnelBridgeService({
    createOperationId: randomUUID,
    enableDefaults: createNodeSafeTunnelEnableDefaultsProvider({
      serverAddress: options.serverAddress,
    }),
    fileExists: existsSync,
    runtime,
    safeTunnel,
  });
}
