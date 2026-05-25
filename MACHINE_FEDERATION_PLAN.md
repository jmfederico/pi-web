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

Default behavior when no file exists:

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

- `local` machine cannot be deleted.
- Remote `baseUrl` must be `http:` or `https:`.
- Normalize `baseUrl` by trimming trailing slash.
- Do not return `token` in normal responses.

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

- Read/write `$PI_WEB_DATA_DIR/machines.json`.
- Return default local machine if file is missing.
- Validate JSON shape.
- Generate stable IDs for new remote machines.

### `MachineService`

Responsibilities:

- CRUD machine records.
- Prevent deleting `local`.
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
interface MachineClient {
  request(method: string, path: string, body?: unknown): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  }>;
  connectWebSocket(path: string): WebSocket;
}
```

For `local`, this can be backed by direct local services where practical or by existing local route handlers/session daemon clients. For first implementation, keep local code paths mostly unchanged and add route wrappers.

### Route implementation strategy

1. Extract current route registration to support a path prefix and a target selector where possible.
2. Keep existing local routes untouched initially.
3. Add machine-scoped wrappers:
   - If `machineId === "local"`, call current local services.
   - Else proxy equivalent path to remote machine without the `/api/machines/:machineId` prefix.

Example remote mapping:

```text
GET /api/machines/devbox/projects
 -> GET https://devbox.example.ts.net/api/projects

WS /api/machines/devbox/sessions/abc/events
 -> WS wss://devbox.example.ts.net/api/sessions/abc/events
```

This lets remote machines run unmodified Pi Web at first. Later, when remote Pi Web also supports machine-scoped APIs, the gateway can still target the compatibility aliases on that remote.

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

- default local machine when no machines file exists;
- add remote machine;
- reject invalid base URLs;
- do not expose token in response;
- cannot delete local machine;
- route read/write with and without `machine`;
- switching machine clears project/workspace/session state;
- missing route machine falls back to local.

### Integration tests

Add server route tests with mocked remote machine client:

- `GET /api/machines/remote/projects` proxies to `/api/projects` on remote.
- Remote non-2xx status passes through reasonably.
- Remote unreachable returns 502 with useful error.
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

Deliverable: Pi Web has a Machines list, but only `local` exists and all existing behavior works.

Tasks:

- Add `Machine` shared types.
- Add `MachineStore`, `MachineService`, and `/api/machines` routes.
- Add client `machinesApi`.
- Add `MachineController`.
- Add `selectedMachine` to app state.
- Add `MachineList` above `ProjectList`.
- Route supports `?machine=local` but does not require it.
- Existing `/api/projects` routes remain unchanged.

Acceptance:

- Fresh UI shows `Local` under Machines.
- Current project/workspace/session workflows unchanged.
- Current URLs continue to work.

### Phase 2: Machine-scoped local aliases

Deliverable: machine-scoped APIs work for `local`.

Tasks:

- Add `/api/machines/local/projects` etc. wrappers for local services.
- Add `/api/machines/local/sessions...` proxy wrappers to local sessiond.
- Add `/api/machines/local/events` WebSocket wrappers.
- Update client API/controllers to use machine-scoped endpoints.
- Keep compatibility aliases.

Acceptance:

- Browser uses `/api/machines/local/...` for normal operation.
- Compatibility aliases still pass tests.

### Phase 3: Remote HTTP proxy

Deliverable: remote machines can list projects/workspaces/sessions and perform non-WebSocket actions.

Tasks:

- Add remote `MachineClient`.
- Add `GET /api/machines/:id/health`.
- Proxy machine-scoped HTTP routes for remote machines to remote compatibility routes.
- Add token/header support.
- Add UI for add/remove remote machines.

Acceptance:

- Register another running Pi Web by URL.
- List remote projects/workspaces/sessions.
- Start session and send prompt via proxied HTTP.

### Phase 4: Remote WebSocket proxy

Deliverable: remote live sessions and terminals work.

Tasks:

- Proxy session event WebSockets to remote Pi Web.
- Proxy global events/activity WebSocket for selected machine.
- Proxy terminal socket WebSockets.
- Make `SessionSocket`, `RealtimeSocket`, and `terminalSocket` machine-scoped.

Acceptance:

- Remote assistant streaming appears live.
- Remote status/activity updates appear.
- Remote terminals work.

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
2. Should `machines.json` store secrets directly, or should it use a separate secret store later?
3. Should central Pi Web allow adding projects to remote machines, or only list existing remote projects at first?
4. Should activity be subscribed only for selected machine, or for all machines with active health polling?
5. Should machine IDs be user-chosen slugs or generated UUIDs with editable names?
6. Should machine-scoped remote routes target the remote compatibility aliases forever, or require remote Pi Web to also be machine-aware?
7. How much of this should be proposed upstream in one PR vs several PRs?

## Suggested first PR scope

The safest first PR is Phase 1 only:

> Introduce a first-class `Machine` model with a default local machine and a machine selector UI, without changing remote behavior yet.

That PR should be easy to review because it preserves all existing runtime behavior and creates the seam for federation.
