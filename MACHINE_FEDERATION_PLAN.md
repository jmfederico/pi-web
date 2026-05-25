# Machine Federation Plan

Goal: extend Pi Web from the current hierarchy:

```text
Project -> Workspace -> Session
```

to:

```text
Machine -> Project -> Workspace -> Session
```

A machine is a Pi Web runtime endpoint. The local machine is the current Pi Web install. Remote machines are other Pi Web installs reachable over HTTP/WebSocket, ideally through a trusted network/tunnel such as Tailscale, WireGuard, SSH forwarding, or a reverse proxy with auth.

## Design principles

1. **Upstreamable, not permanent-fork-only**
   - Keep existing behavior working by auto-providing a default `local` machine.
   - Keep current non-machine-scoped API routes as compatibility aliases for the local machine.
   - Implement in small, reviewable phases.

2. **Machine is a server-side concept first**
   - Do not implement federation only in browser plugins.
   - The browser should keep a single origin: the currently opened Pi Web server.
   - The local Pi Web server acts as a gateway/proxy to remote Pi Web servers.

3. **No direct remote browser calls by default**
   - Avoid CORS problems and scattered credentials in browser code.
   - Proxy HTTP and WebSocket traffic through the local Pi Web server.

4. **Security explicitness**
   - Pi Web is currently documented as trusted-user/trusted-path tooling, not a secure multi-tenant platform.
   - Remote machines must be opt-in and should support token/header configuration before being exposed beyond private networks.

5. **Minimal domain disruption**
   - Projects, workspaces, sessions, files, git, terminals, activity, and auth remain owned by each target machine.
   - Federation initially aggregates/proxies; it does not replicate remote state locally beyond machine registry and optional health cache.

## Non-goals for first implementation

- Multi-user RBAC.
- Public internet exposure guidance beyond warnings and token/private-network support.
- Cross-machine project import/sync.
- Cross-machine worktree management.
- Shared session IDs across machines. Session IDs are unique only within a machine unless namespaced client-side.
- Running remote session daemons directly from the central server. Remote machines should run their own Pi Web.

## Data model

Add shared API types in `src/shared/apiTypes.ts`:

```ts
export type MachineKind = "local" | "remote";
export type MachineStatus = "unknown" | "online" | "offline" | "error";

export interface Machine {
  id: string;
  name: string;
  kind: MachineKind;
  baseUrl?: string;          // absent for local
  createdAt: string;
  updatedAt: string;
  status?: MachineStatus;    // optional summary from health checks
  statusMessage?: string;
}

export interface MachineHealth {
  machineId: string;
  ok: boolean;
  checkedAt: string;
  status?: MachineStatus;
  web?: PiWebComponentStatus;
  sessiond?: PiWebComponentStatus;
  error?: string;
}
```

Server-only stored record can include fields that should not be echoed casually:

```ts
interface StoredMachine {
  id: string;
  name: string;
  kind: "local" | "remote";
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}
```

Initial storage file:

```text
$PI_WEB_DATA_DIR/machines.json
```

Allow tests and advanced deployments to override it with:

```text
PI_WEB_MACHINES_FILE=/path/to/machines.json
```

The `local` machine is synthesized by the service, not persisted. The stored file contains remote machines only. This keeps the default local endpoint stable, prevents accidental deletion/corruption of the built-in machine, and allows a fresh install with no `machines.json` to behave exactly like current Pi Web.

Default behavior when no file exists:

```json
{
  "machines": []
}
```

API responses still include the synthesized local machine first:

```json
{
  "machines": [
    {
      "id": "local",
      "name": "Local",
      "kind": "local"
    }
  ]
}
```

## API shape

### Machine registry

New canonical routes:

```text
GET    /api/machines
POST   /api/machines
GET    /api/machines/:machineId
PATCH  /api/machines/:machineId
DELETE /api/machines/:machineId
GET    /api/machines/:machineId/health
```

Example create request:

```json
{
  "name": "Dev Box",
  "baseUrl": "https://devbox.example.ts.net",
  "token": "optional-token"
}
```

Rules:

- `local` machine cannot be created, patched, or deleted through the registry because it is synthesized.
- Remote `baseUrl` must be `http:` or `https:`.
- Remote `baseUrl` must not include username/password, query, or hash components.
- Normalize `baseUrl` by trimming trailing slash.
- Do not return `token` in normal responses.
- Treat machine registry credentials as gateway-to-remote Pi Web credentials, not model-provider credentials.

### Machine-scoped project/workspace/file/git routes

Canonical new routes:

```text
GET    /api/machines/:machineId/projects
POST   /api/machines/:machineId/projects
DELETE /api/machines/:machineId/projects/:projectId
GET    /api/machines/:machineId/project-directories?q=...
GET    /api/machines/:machineId/projects/:projectId/workspaces
GET    /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/tree?path=...
GET    /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/file?path=...
GET    /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/file/preview?path=...
GET    /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/git/status
GET    /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/git/diff?path=...&staged=true
GET    /api/machines/:machineId/files?cwd=...&q=...&kind=...&mode=...
```

Compatibility aliases keep using local machine:

```text
/api/projects...
/api/project-directories...
/api/files...
```

### Machine-scoped sessions/auth/activity

Canonical new routes:

```text
GET  /api/machines/:machineId/activity
GET  /api/machines/:machineId/auth...
GET  /api/machines/:machineId/sessions?cwd=...
POST /api/machines/:machineId/sessions
GET  /api/machines/:machineId/sessions/:sessionId/messages
GET  /api/machines/:machineId/sessions/:sessionId/status
POST /api/machines/:machineId/sessions/:sessionId/prompt
POST /api/machines/:machineId/sessions/:sessionId/shell
POST /api/machines/:machineId/sessions/:sessionId/archive
...
```

Compatibility aliases keep using local machine:

```text
/api/activity
/api/auth...
/api/sessions...
```

Remote auth policy for first remote implementation:

- Machine registry `token`/`headers` authenticate the gateway to the remote Pi Web instance.
- Model-provider API keys and OAuth state remain owned by each target machine/session daemon.
- API-key provider configuration may be proxied once the normal remote HTTP proxy is working.
- OAuth flows should not be fully proxied in the first remote phase. The UI should offer to open the selected remote Pi Web directly for OAuth login/logout until callback origin behavior is explicitly designed and tested.
- If a remote auth endpoint is unavailable or intentionally unsupported, return a clear error telling the user to configure auth on the remote machine.

### Machine-scoped WebSockets

Canonical new routes:

```text
WS /api/machines/:machineId/events
WS /api/machines/:machineId/sessions/events
WS /api/machines/:machineId/sessions/:sessionId/events
WS /api/machines/:machineId/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket
```

Compatibility aliases keep using local machine:

```text
WS /api/events
WS /api/sessions/events
WS /api/sessions/:sessionId/events
WS /api/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket
```

## Server architecture

Add these server modules:

```text
src/server/machines/machineStore.ts
src/server/machines/machineService.ts
src/server/machines/machineClient.ts
src/server/machines/machineRoutes.ts
src/server/machines/machineProxyRoutes.ts
```

### `MachineStore`

Responsibilities:

- Read/write `$PI_WEB_DATA_DIR/machines.json`, or `PI_WEB_MACHINES_FILE` when configured.
- Store remote machine records only. Do not persist the synthesized `local` machine.
- Return an empty remote list if the file is missing.
- Validate JSON shape.
- Generate stable IDs for new remote machines.

### `MachineService`

Responsibilities:

- CRUD remote machine records.
- Synthesize the built-in `local` machine in list/get responses.
- Prevent creating, patching, or deleting `local`.
- Resolve a machine by ID.
- Create an appropriate gateway target:
  - local target: existing services and local session daemon client;
  - remote target: `RemoteMachineClient`.

### `RemoteMachineClient`

Responsibilities:

- HTTP proxy requests to remote Pi Web base URL.
- WebSocket proxy requests to remote Pi Web base URL.
- Attach auth headers/token when configured.
- Normalize remote failures into useful gateway errors.

Pseudo-interface:

```ts
interface MachineHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer | NodeJS.ReadableStream;
}

interface MachineClient {
  request(method: string, path: string, body?: unknown): Promise<MachineHttpResponse>;
  connectWebSocket(path: string): WebSocket;
}
```

The interface must support streaming/binary responses because file previews and future downloads cannot safely be represented as JSON strings.

For `local`, this can be backed by direct local services where practical or by existing local route handlers/session daemon clients. For first implementation, keep local code paths mostly unchanged and add route wrappers.

### Route implementation strategy

1. Extract current route registration to support a path prefix and a target selector where possible.
2. Keep existing local routes untouched initially.
3. Add machine-scoped wrappers:
   - If `machineId === "local"`, call current local services.
   - Else proxy equivalent path to remote machine without the `/api/machines/:machineId` prefix.

Path translation must be explicit and tested:

```text
/api/machines/:machineId/<compat-path>
  -> /api/<compat-path> for remote Pi Web HTTP/WebSocket routes
  -> /<compat-path> for local sessiond routes where sessiond expects non-/api paths
```

Examples:

```text
GET /api/machines/devbox/projects
 -> GET https://devbox.example.ts.net/api/projects

WS /api/machines/devbox/sessions/abc/events
 -> WS wss://devbox.example.ts.net/api/sessions/abc/events

GET /api/machines/local/sessions/abc/status
 -> local sessiond GET /sessions/abc/status
```

This lets remote machines run unmodified Pi Web at first. Later, when remote Pi Web also supports machine-scoped APIs, the gateway can still target the compatibility aliases on that remote.

Proxy response handling rules:

- Preserve query strings exactly after the machine prefix is stripped.
- Pass through successful JSON responses using normal API parsers.
- Pass through binary/streaming responses such as file previews without buffering into strings.
- Forward only safe response headers such as `content-type`, `content-length`, `cache-control`, `last-modified`, and `etag`.
- Strip hop-by-hop headers such as `connection`, `transfer-encoding`, `upgrade`, `keep-alive`, and `proxy-authenticate`.
- Apply short request timeouts for health checks and bounded timeouts for normal HTTP proxy requests.
- Normalize remote unreachable/timeouts to gateway errors (`502`/`504`) with clear messages.

Proxy security rules:

- Never ignore TLS certificate errors by default.
- Do not follow redirects for proxied API requests unless there is a specific, reviewed need.
- Do not forward browser credentials/cookies to remote machines by default.
- Only attach credentials configured on the machine record, and block configured headers that would override transport semantics such as `host`, `connection`, `upgrade`, `transfer-encoding`, `content-length`, or `authorization` unless the field is the explicit token/auth mechanism.
- Use request body size limits consistent with the existing local API.
- Use response size limits for JSON endpoints where practical; streaming/binary endpoints should stream with timeout/backpressure rather than unbounded buffering.
- Private network URLs are allowed because Tailscale/WireGuard/SSH tunnels are a primary use case, but the UI and docs should warn that registering a machine gives the local Pi Web server permission to contact that endpoint.

## Client architecture

### State changes

In `src/client/src/appState.ts`, add:

```ts
machines: Machine[];
selectedMachine: Machine | undefined;
isLoadingMachines: boolean;
machineStatuses: Record<string, MachineHealth>;
projectsByMachineId: Record<string, Project[]>;
workspacesByMachineProjectId: Record<string, Workspace[]>;
```

Consider eventually replacing current flat `projects`, `workspaces`, `sessions` with selected-machine views. For the first pass, keep flat selected lists and reload them when machine changes:

```ts
projects     // projects for selectedMachine
workspaces   // workspaces for selectedProject on selectedMachine
sessions     // sessions for selectedWorkspace on selectedMachine
```

### Cross-machine identity and cache keys

Server APIs should keep returning the target machine's native IDs. The client must namespace any state, cache, route restoration, or lookup table that can contain entities from more than one machine.

Use helper functions rather than ad hoc string concatenation:

```ts
const machineProjectKey = (machineId: string, projectId: string) => `${machineId}:${projectId}`;
const machineWorkspaceKey = (machineId: string, projectId: string, workspaceId: string) => `${machineId}:${projectId}:${workspaceId}`;
const machineSessionKey = (machineId: string, sessionId: string) => `${machineId}:${sessionId}`;
```

At minimum, namespace:

- `workspacesByProjectId` or its replacement;
- `sessionStatuses`;
- `sessionActivities`;
- `workspaceActivities`;
- chat transcript caches;
- prompt draft storage;
- any cached new-session or session-restoration state;
- terminal socket state if more than one machine can be active at a time.

Flat selected-machine views are still fine for rendering, but persisted and long-lived maps should never assume project, workspace, session, or terminal IDs are globally unique.

### API client changes

In `src/client/src/api/clients.ts`, add:

```ts
machinesApi.machines()
machinesApi.addMachine(...)
machinesApi.deleteMachine(...)
machinesApi.health(machineId)
```

Then add machine-scoped variants or a helper:

```ts
const machinePrefix = (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}`;

projects(machineId)
addProject(machineId, path, name, create)
workspaces(machineId, projectId)
sessions(machineId, cwd)
...
```

Initial compatibility choice:

- Update controllers to require `selectedMachine?.id ?? "local"`.
- Keep API function names but add `machineId` as the first arg where needed.

### Controllers

Add:

```text
src/client/src/controllers/machineController.ts
```

Responsibilities:

- load machines;
- select machine;
- add/edit/delete machine;
- refresh machine health;
- clear project/workspace/session state on machine switch;
- select default local machine on startup if route has none.

Modify existing controllers:

- `ProjectController`: load/add/close projects for selected machine.
- `WorkspaceController`: select project within selected machine.
- `SessionController`: all session operations use selected machine; session sockets become machine-scoped.
- `ActivityController`: activity socket/API becomes machine-scoped or subscribes per selected machine first.
- `FileExplorerController`, `GitController`, terminal calls: use selected machine.

### Routing

Extend `src/client/src/route.ts`:

```ts
interface AppRoute {
  machineId: string | undefined;
  projectId: string | undefined;
  workspaceId: string | undefined;
  sessionId: string | undefined;
  tool: QualifiedContributionId | undefined;
  view: "chat" | QualifiedContributionId | undefined;
}
```

Query param:

```text
?machine=local&project=...&workspace=...&session=...
```

Compatibility:

- Missing `machine` means `local`.
- Current URLs keep working.

### UI

Add a machine list above projects in navigation:

```text
Machines
  Local
  Dev Box
Projects
  ...
Workspaces
  ...
Sessions
  ...
```

New component:

```text
src/client/src/components/MachineList.ts
```

New/updated dialogs:

- `MachineDialog` or reuse action palette flow:
  - Add Machine
  - Edit Machine
  - Remove Machine
  - Refresh Machine Health

Action palette additions:

- `Add Machine`
- `Refresh Machine`
- `Open Selected Machine Pi Web` for remote base URL

Status/labels:

- Show online/offline marker next to machines.
- Show selected machine in `StatusBar` so users know which host they are controlling.

## Plugin API impact

Current plugin stable context has selected workspace/session. Add selected machine once the client model is stable:

```ts
interface PluginRuntimeState {
  selectedMachine?: Machine;
  selectedWorkspace?: Workspace;
  selectedSession?: unknown;
  ...
}
```

Potential future contribution type:

```ts
machineLabels?: MachineLabelContribution[];
machinePanels?: MachinePanelContribution[];
```

Do **not** add this in phase 1 unless needed. Keep plugin changes minimal: expose `selectedMachine` in state after core UI works.

## Testing plan

### Unit tests

Add tests for:

```text
src/server/machines/machineStore.test.ts
src/server/machines/machineService.test.ts
src/server/machines/machineClient.test.ts
src/server/machines/machineRoutes.test.ts
src/client/src/controllers/machineController.test.ts
src/client/src/route.test.ts
```

Cover:

- default local machine is synthesized when no machines file exists;
- `machines.json` stores remote machines only and does not persist `local`;
- `PI_WEB_MACHINES_FILE` overrides the default store path;
- add remote machine;
- reject invalid base URLs, including username/password, query, and hash components;
- do not expose token in response;
- cannot create, patch, or delete local machine;
- route read/write with and without `machine`;
- switching machine clears project/workspace/session state;
- machine-scoped cache key helpers avoid collisions;
- missing route machine falls back to local.

### Integration tests

Add server route tests with mocked remote machine client:

- `GET /api/machines/remote/projects` proxies to `/api/projects` on remote.
- local sessiond path mapping strips `/api/machines/local` and forwards `/sessions...`, `/auth...`, and `/activity` correctly.
- Remote non-2xx status passes through reasonably.
- Remote unreachable returns 502 with useful error.
- Remote timeout returns 504 with useful error.
- Binary/streaming responses such as file previews are not coerced into strings.
- Hop-by-hop headers are stripped and safe response headers are preserved.
- WebSocket path mapping uses `ws:`/`wss:` correctly.

### Manual test matrix

1. Fresh install, no `machines.json`:
   - UI loads Local machine.
   - Existing project/workspace/session behavior works.
   - Existing URLs without `machine` work.

2. Add local project and start session:
   - No regressions in chat, files, git, terminal.

3. Register remote Pi Web over Tailscale/localhost tunnel:
   - Machine appears online.
   - Remote projects list loads.
   - Remote workspaces list loads.
   - Remote sessions list loads.
   - Start/select session works.
   - WebSocket events stream.
   - Terminal socket works.

4. Remote machine offline:
   - UI shows offline/error.
   - Selecting machine does not crash app.
   - Error messages are clear.

## Implementation phases

### Phase 0: Planning and baseline

- Keep this plan updated.
- Run baseline tests/typecheck before code changes.
- Identify current failures, if any.

Commands:

```bash
npm install
npm run typecheck
npm test
```

### Phase 1: Local machine registry only

Deliverable: Pi Web has a Machines list, but only synthesized `local` exists and all existing behavior works.

This can be split into two PRs if review size matters:

- Phase 1a: shared `Machine` types, remote-only `MachineStore`, `MachineService`, `/api/machines` routes, and tests.
- Phase 1b: client `machinesApi`, `MachineController`, selected-machine state, route support, and Local-only UI.

Tasks:

- Add `Machine` shared types.
- Add remote-only `MachineStore`, `MachineService`, and `/api/machines` routes that synthesize `local`.
- Add client `machinesApi`.
- Add `MachineController`.
- Add `selectedMachine` to app state.
- Add `MachineList` above `ProjectList`.
- Route supports `?machine=local` but does not require it.
- Existing `/api/projects` routes remain unchanged.

Acceptance:

- Fresh UI shows synthesized `Local` under Machines.
- Current project/workspace/session workflows unchanged.
- Current URLs continue to work.

### Phase 2: Machine-scoped local aliases

Deliverable: machine-scoped APIs work for the synthesized `local` machine, and the browser uses those endpoints for normal local operation. Remote machine rows may still be listed, but remote project/session control remains unavailable until Phase 3/4.

Implementation strategy:

- Prefer extracting existing route registration functions to accept a path prefix when this is low-risk.
- If extraction would be broad, add small wrapper route modules first and refactor later.
- Keep every existing non-machine-scoped route as a compatibility alias for `local`.
- Migrate client calls in route-family slices so regressions are easy to isolate:
  1. projects, project directories, workspaces;
  2. files, file previews, git;
  3. sessions, auth providers, activity HTTP;
  4. local WebSockets and terminals if they are not deferred to Phase 4.

Local service route mapping:

```text
GET    /api/machines/local/projects
  -> ProjectService.list()
POST   /api/machines/local/projects
  -> ProjectService.add()
DELETE /api/machines/local/projects/:projectId
  -> ProjectService.close()

GET    /api/machines/local/project-directories?q=...
  -> listDirectorySuggestions()

GET    /api/machines/local/projects/:projectId/workspaces
  -> WorkspaceService.list(project)

GET    /api/machines/local/projects/:projectId/workspaces/:workspaceId/tree?path=...
  -> listWorkspaceTree()
GET    /api/machines/local/projects/:projectId/workspaces/:workspaceId/file?path=...
  -> readWorkspaceFile()
GET    /api/machines/local/projects/:projectId/workspaces/:workspaceId/file/preview?path=...
  -> readWorkspaceImagePreview() streaming response

GET    /api/machines/local/projects/:projectId/workspaces/:workspaceId/git/status
  -> current git status route behavior
GET    /api/machines/local/projects/:projectId/workspaces/:workspaceId/git/diff?path=...&staged=true
  -> current git diff route behavior

GET    /api/machines/local/files?cwd=...&q=...&kind=...&mode=...
  -> listFileSuggestions() / listPathSuggestions()
```

Local session daemon route mapping:

```text
GET/POST/etc /api/machines/local/activity
  -> local sessiond /activity
GET/POST/etc /api/machines/local/auth
  -> local sessiond /auth
GET/POST/etc /api/machines/local/auth/*
  -> local sessiond /auth/*
GET/POST/etc /api/machines/local/sessions
  -> local sessiond /sessions
GET/POST/etc /api/machines/local/sessions/*
  -> local sessiond /sessions/*
```

Local WebSocket mapping:

```text
WS /api/machines/local/events
  -> local sessiond /events
WS /api/machines/local/sessions/events
  -> local sessiond /sessions/events
WS /api/machines/local/sessions/:sessionId/events
  -> local sessiond /sessions/:sessionId/events
WS /api/machines/local/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket?cols=...&rows=...
  -> existing local terminal socket behavior with query preserved
```

Client API changes:

```ts
const machinePrefix = (machineId: string) => `/api/machines/${encodeURIComponent(machineId)}`;

projects(machineId)
addProject(machineId, path, name, create)
closeProject(machineId, projectId)
projectDirectories(machineId, query)
workspaces(machineId, projectId)
workspaceTree(machineId, projectId, workspaceId, path)
workspaceFile(machineId, projectId, workspaceId, path)
workspaceFilePreview(machineId, projectId, workspaceId, path)
gitStatus(machineId, projectId, workspaceId)
gitDiff(machineId, projectId, workspaceId, options)
files(machineId, cwd, query, kind, mode)
sessions(machineId, cwd)
...
```

Controller rules:

- Controllers must derive `machineId` from `selectedMachine?.id ?? "local"`.
- While only local aliases are implemented, remote machines should remain non-operational in the project/session controllers and show clear “remote control coming soon” copy.
- Route restoration must restore machine selection before project/workspace/session selection.
- Cache keys introduced in this phase should be machine-scoped if they can outlive the selected-machine view.

Acceptance:

- Browser network panel shows `/api/machines/local/...` for local project/workspace/session activity.
- Current compatibility routes such as `/api/projects` and `/api/sessions` still pass tests.
- Existing URLs without `machine` continue to restore local projects/workspaces/sessions.
- `?machine=local` is accepted but normal URL writes omit it.
- Selecting any remote row does not show local projects or local sessions under the remote machine.

### Phase 3: Remote HTTP proxy

Deliverable: remote machines can list projects/workspaces/sessions and perform non-WebSocket actions through the local Pi Web gateway.

Remote proxy route allowlist:

```text
GET    /api/machines/:id/projects
POST   /api/machines/:id/projects
DELETE /api/machines/:id/projects/:projectId
GET    /api/machines/:id/project-directories?q=...
GET    /api/machines/:id/projects/:projectId/workspaces
GET    /api/machines/:id/projects/:projectId/workspaces/:workspaceId/tree?path=...
GET    /api/machines/:id/projects/:projectId/workspaces/:workspaceId/file?path=...
GET    /api/machines/:id/projects/:projectId/workspaces/:workspaceId/file/preview?path=...
GET    /api/machines/:id/projects/:projectId/workspaces/:workspaceId/git/status
GET    /api/machines/:id/projects/:projectId/workspaces/:workspaceId/git/diff?path=...&staged=true
GET    /api/machines/:id/files?cwd=...&q=...&kind=...&mode=...
GET    /api/machines/:id/activity
GET    /api/machines/:id/sessions?cwd=...
POST   /api/machines/:id/sessions
GET    /api/machines/:id/sessions/:sessionId/messages
GET    /api/machines/:id/sessions/:sessionId/status
GET    /api/machines/:id/sessions/:sessionId/models
POST   /api/machines/:id/sessions/:sessionId/model
POST   /api/machines/:id/sessions/:sessionId/model/cycle
GET    /api/machines/:id/sessions/:sessionId/thinking-levels
POST   /api/machines/:id/sessions/:sessionId/thinking-level
POST   /api/machines/:id/sessions/:sessionId/thinking-level/cycle
GET    /api/machines/:id/sessions/:sessionId/commands
POST   /api/machines/:id/sessions/:sessionId/prompt
POST   /api/machines/:id/sessions/:sessionId/shell
POST   /api/machines/:id/sessions/:sessionId/commands/run
POST   /api/machines/:id/sessions/:sessionId/commands/respond
POST   /api/machines/:id/sessions/:sessionId/abort
POST   /api/machines/:id/sessions/:sessionId/stop
POST   /api/machines/:id/sessions/:sessionId/archive
POST   /api/machines/:id/sessions/:sessionId/archive-tree
POST   /api/machines/:id/sessions/:sessionId/restore
POST   /api/machines/:id/sessions/:sessionId/detach-parent
GET    /api/machines/:id/auth/providers
POST   /api/machines/:id/auth/api-key
POST   /api/machines/:id/auth/logout        // API-key/logout only if safe for selected provider
```

Do not add a catch-all remote proxy in the first remote phase. Any route not explicitly allowlisted should return `404` or `501` with a clear message.

Remote path mapping:

```text
/api/machines/:id/<compat-path>?query
  -> <machine.baseUrl>/api/<compat-path>?query
```

Rules:

- Preserve query strings exactly after the machine prefix is stripped.
- Forward JSON request bodies with `content-type: application/json` unless the original route needs a different explicit content type.
- Stream file preview responses; do not coerce previews into JSON strings.
- Use the same request body limits as the local Fastify API.
- Use bounded timeouts for normal HTTP proxy requests, and shorter timeouts for health checks.

Remote auth/header policy:

- `token` means `Authorization: Bearer <token>` by default.
- `headers` are additional gateway-to-remote headers.
- Never forward browser cookies, browser `Authorization`, or other browser credentials to a remote machine by default.
- Reject or ignore configured header names that affect transport/proxy semantics:
  - `host`
  - `connection`
  - `upgrade`
  - `transfer-encoding`
  - `content-length`
  - `keep-alive`
  - `proxy-authenticate`
  - `proxy-authorization`
  - `te`
  - `trailer`
- If both `token` and `headers.authorization` are provided, reject the machine config or require one explicit winner. Prefer rejecting ambiguity.
- Never disable TLS verification by default.
- Do not follow redirects for proxied API requests in v1.

Remote response header policy:

- Preserve safe response headers where useful:
  - `content-type`
  - `content-length`
  - `cache-control`
  - `last-modified`
  - `etag`
- Strip hop-by-hop and credential-bearing headers:
  - `connection`
  - `transfer-encoding`
  - `upgrade`
  - `keep-alive`
  - `proxy-authenticate`
  - `proxy-authorization`
  - `set-cookie`
- Normalize remote failures to JSON gateway errors for JSON endpoints.

Error response contract:

```json
{
  "error": "Remote machine unavailable",
  "machineId": "devbox",
  "statusCode": 502,
  "detail": "connect ECONNREFUSED 100.64.0.2:8504"
}
```

Guidance:

- Remote DNS/connect/TLS failure: `502`.
- Remote timeout: `504`.
- Unknown machine: `404`.
- Route known but not implemented remotely/gateway-side: preserve remote `404` when it came from remote, use gateway `501` when the gateway intentionally does not support it.
- Avoid leaking configured tokens/headers in errors or logs.

Health endpoint contract:

```text
GET /api/machines/:id/health
```

- `local` health combines existing Pi Web status and sessiond health where practical.
- Remote health calls `<baseUrl>/api/pi-web/status` with a short timeout.
- If the remote is old and lacks `/api/pi-web/status`, fall back to a lightweight `GET /api/projects` or root request only if that fallback is deliberate and tested.
- Responses should include `checkedAt`, `ok`, `status`, and optional component statuses.
- Cache health in memory for a short TTL so selecting machines does not block on repeated offline checks.

Remote auth provider policy:

- Gateway-to-remote machine credentials are separate from model-provider credentials.
- API-key provider flows may be proxied after basic remote HTTP proxying works.
- OAuth login/logout remains remote-direct in Phase 3. UI should show “Open remote Pi Web to configure OAuth” rather than proxying callback-sensitive flows.

Acceptance:

- Register another running Pi Web by URL.
- Health shows online/offline without blocking the UI.
- List remote projects/workspaces/sessions through machine-scoped endpoints.
- Start a remote session and send a prompt via proxied HTTP.
- Remote file tree/file content/git status work.
- Remote file previews stream with correct content type.
- Remote unreachable returns `502`; timeout returns `504`; token/header values never appear in responses or logs.
- Existing local and compatibility routes still pass tests.

### Phase 4: Remote WebSocket proxy

Deliverable: remote live sessions and terminals work through the local Pi Web gateway.

Remote WebSocket route mapping:

```text
WS /api/machines/:id/events
  -> <remote ws base>/api/events
WS /api/machines/:id/sessions/events
  -> <remote ws base>/api/sessions/events
WS /api/machines/:id/sessions/:sessionId/events
  -> <remote ws base>/api/sessions/:sessionId/events
WS /api/machines/:id/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket?cols=...&rows=...
  -> <remote ws base>/api/projects/:projectId/workspaces/:workspaceId/terminals/:terminalId/socket?cols=...&rows=...
```

Rules:

- Convert remote `http:` base URLs to `ws:` and `https:` base URLs to `wss:`.
- Preserve query strings exactly, especially terminal `cols` and `rows`.
- Attach the same gateway-to-remote credentials as HTTP proxying where WebSocket libraries support headers.
- Do not forward browser cookies or browser credentials.
- If upstream connect fails, close the browser WebSocket with a clear close code/reason where possible and log a sanitized gateway error.
- Forward upstream close codes/reasons to the browser when safe.
- Forward browser close to upstream and upstream close to browser.
- Buffer browser messages only while the upstream socket is connecting, with a small max buffer. Drop/close on overflow rather than unbounded buffering.
- Reuse or extend `src/server/webSocketBridge.ts` so buffering/close/error behavior is consistent.
- Add heartbeat/ping behavior only if tests or real remote tunnels show idle sockets are dropped; do not introduce timers without cleanup.

Client socket API changes:

```ts
sessionEvents(machineId: string, sessionId: string): WebSocket
globalSessionEvents(machineId: string): WebSocket
realtimeEvents(machineId: string): WebSocket
terminalSocket(machineId: string, projectId: string, workspaceId: string, terminalId: string, initialSize?: TerminalSize): WebSocket
```

Controller/socket ownership rules:

- `SessionSocket` reconnects using the selected machine ID.
- `RealtimeSocket` reconnects when selected machine changes.
- Terminal sockets are scoped to the selected machine and are closed when switching machines/workspaces.
- Activity/status maps use machine-scoped cache keys if data from multiple machines can coexist.

Acceptance:

- Remote assistant streaming appears live.
- Remote status/activity updates appear.
- Remote terminals work, including initial size query parameters.
- Closing the browser tab/session closes upstream WebSockets.
- Offline remote WebSocket attempts fail visibly without crashing the app.
- Local WebSockets and compatibility aliases still pass tests.

### Phase 5: UX polish and docs

Deliverable: feature is usable and explainable.

Tasks:

- Machine health indicators.
- Selected machine in status bar.
- Empty states updated from “Add project” to “Select/add machine, then add project”.
- Docs for Tailscale/SSH/reverse-proxy setup.
- Security warnings.
- Plugin state includes `selectedMachine`.

Acceptance:

- New users understand local vs remote control.
- Remote errors are actionable.
- Docs explain safe setup.

## Key files likely touched

Server:

```text
src/shared/apiTypes.ts
src/server/app.ts
src/server/machines/*
src/server/sessiond/sessionProxyRoutes.ts
src/server/terminalProxyRoutes.ts
src/server/workspaceExplorerRoutes.ts
src/server/gitRoutes.ts
src/server/storage/projectStore.ts       // probably not changed in phase 1
src/server/projects/projectService.ts     // probably not changed in phase 1
```

Client:

```text
src/client/src/appState.ts
src/client/src/api/clients.ts
src/client/src/api/parsers.ts
src/client/src/api/sockets.ts
src/client/src/api/urls.ts
src/client/src/components/PiWebApp.ts
src/client/src/components/MachineList.ts
src/client/src/components/ProjectDialog.ts  // maybe later for machine-aware copy
src/client/src/components/StatusBar.ts
src/client/src/controllers/machineController.ts
src/client/src/controllers/projectController.ts
src/client/src/controllers/workspaceController.ts
src/client/src/controllers/sessionController.ts
src/client/src/controllers/activityController.ts
src/client/src/controllers/fileExplorerController.ts
src/client/src/controllers/gitController.ts
src/client/src/route.ts
src/client/src/sessionSocket.ts
src/client/src/plugins/types.ts             // later
```

Docs:

```text
README.md
docs/machines.md or docs/federation.md
```

## Open questions

1. Should remote machine auth be a bearer token, arbitrary headers, or both?
2. Should remote machine secrets in `machines.json` stay inline for v1, or should they use a separate secret store later?
3. Should central Pi Web allow adding projects to remote machines, or only list existing remote projects at first?
4. Should activity be subscribed only for selected machine, or for all machines with active health polling?
5. Should machine IDs be user-chosen slugs or generated UUIDs with editable names?
6. Should machine-scoped remote routes target the remote compatibility aliases forever, or require remote Pi Web to also be machine-aware?
7. How much of this should be proposed upstream in one PR vs several PRs?

## Suggested first PR scope

The safest first PR is Phase 1 only:

> Introduce a first-class `Machine` model with a default local machine and a machine selector UI, without changing remote behavior yet.

That PR should be easy to review because it preserves all existing runtime behavior and creates the seam for federation.
