/**
 * Hosted-authoritative Safe Tunnel provider fixtures for PI WEB tests.
 *
 * `hostedFrpcConfigToml` mirrors the hosted Control API serializer
 * `serializeFrpcConfigToml` (pi-web-tunnels
 * `apps/control-api/src/domain/frp-tunnel-config.ts`) byte-for-byte: key
 * order, the dotted `metadatas.pi_web_machine_token` and
 * `transport.tls.enable` root keys, the `[auth]` table, blank lines, and
 * JSON string quoting all come from that serializer, as does the
 * `pi-web-<namespace>-<slug>` proxy name and the
 * `<slug>.<namespace>.<base-domain>` custom domain. Keep this fixture in sync
 * with the hosted serializer; the hosted bridge contract requires PI WEB to
 * accept and preserve exactly this shape.
 */

/** Hosted machine token format: `piwt_mtok_v1_` plus a 32+ character suffix. */
export const hostedMachineToken = "piwt_mtok_v1_abcdefghijklmnopqrstuvwxyz1234567890";

/** Hosted relay transport token format: `piwt_frp_v1_` plus a 32+ character suffix. */
export const hostedRelayAuthToken = "piwt_frp_v1_abcdefghijklmnopqrstuvwxyz1234567890";

export const hostedMachineId = "machine_123";
export const hostedMachineSlug = "my-dev-box";
export const hostedProxyName = "pi-web-userns01-my-dev-box";
export const hostedPublicHostname = "my-dev-box.userns01.tunnels.pi-web.dev";
export const hostedPublicUrl = `https://${hostedPublicHostname}`;
export const hostedLocalPiWebUrl = "http://127.0.0.1:8504";
export const hostedRelayServerAddr = "frps.staging.tunnels.pi-web.dev";
export const hostedRelayServerPort = 7000;

/** Exact `serializeFrpcConfigToml` output for the fixture identities above. */
export const hostedFrpcConfigToml = [
  `serverAddr = ${JSON.stringify(hostedRelayServerAddr)}`,
  `serverPort = ${hostedRelayServerPort.toString()}`,
  'user = ""',
  `metadatas.pi_web_machine_token = ${JSON.stringify(hostedMachineToken)}`,
  "transport.tls.enable = true",
  "",
  "[auth]",
  'method = "token"',
  `token = ${JSON.stringify(hostedRelayAuthToken)}`,
  "",
  "[[proxies]]",
  `name = ${JSON.stringify(hostedProxyName)}`,
  'type = "http"',
  'localIP = "127.0.0.1"',
  "localPort = 8504",
  `customDomains = [${JSON.stringify(hostedPublicHostname)}]`,
  "",
].join("\n");
