export const connectorPackageName = "@jmfederico/pi-web-tunnel";

export {
  connectorConfigDirectoryName,
  connectorConfigFileName,
  createDefaultCliDependencies,
  discoverConnectorConfigDirectory,
  discoverConnectorConfigPath,
  parseCliCommand,
  parseLoginArgs,
  parseRegisterMachineArgs,
  parseStartArgs,
  parseStatusArgs,
  readConnectorStatus,
  runCli,
} from "./cli.js";

export type {
  CliDependencies,
  ConfigPathDependencies,
  ConnectorConfigStatus,
  ConnectorConfigStatusState,
  ConnectorLogStatus,
  ConnectorMachineStatus,
  ConnectorRuntimeStatus,
  ConnectorRuntimeStatusState,
  ConnectorStatus,
  OutputSink,
  RegisterMachineArgs,
  StartArgs,
  StatusArgs,
  StatusDependencies,
} from "./cli.js";

export {
  applyConnectorLoginResultToConfig,
  connectorLoginClientVersion,
  runConnectorLoginFlow,
} from "./connector-login.js";

export type {
  CompletedConnectorDeviceAuthResponse,
  ConnectorLoginArgs,
  ConnectorLoginFlowDependencies,
  ConnectorLoginFlowInput,
  ConnectorLoginResult,
  RegisteredConnectorMachineResponse,
  StartedConnectorDeviceAuthResponse,
} from "./connector-login.js";

export {
  connectorFrpcConfigFileName,
  connectorPidFileName,
  createNodeConnectorRuntimeDependencies,
  fetchMachineTunnelConfig,
  resolveConnectorRuntimePaths,
  runConnectorStart,
  runConnectorStop,
} from "./connector-runtime.js";

export type {
  ConnectorRuntimeDependencies,
  ConnectorRuntimePaths,
  FetchLike,
  FetchLikeRequestInit,
  FetchLikeResponse,
  FetchTunnelConfigDependencies,
  MachineTunnelConfig,
  RunConnectorStartDependencies,
  RunConnectorStopDependencies,
} from "./connector-runtime.js";

export {
  connectorConfigDirectoryMode,
  connectorConfigFileMode,
  connectorConfigSchemaVersion,
  createDefaultConnectorConfig,
  createNodeConnectorConfigStorageDependencies,
  defaultLocalPiWebUrl,
  parseConnectorConfig,
  readConnectorConfig,
  serializeConnectorConfig,
  writeConnectorConfig,
} from "./config-storage.js";

export type {
  ConnectorConfig,
  ConnectorConfigStorageDependencies,
  ConnectorMachineCredentials,
} from "./config-storage.js";
