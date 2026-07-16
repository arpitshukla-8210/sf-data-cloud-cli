# Architecture — `@salesforce/plugin-datacloud-devops`

This document describes the internal architecture of the Data Cloud (Data 360) DevOps CLI plugin: a
**thin client** that brings source-controlled retrieve / deploy to Data Cloud components, at parity
with core `sf project retrieve/deploy`. Every claim below is grounded in the code as it exists in
`src/`; file-and-line references are given so this document can be re-verified against the source.

> **Scope boundary.** This plugin owns **Layer 1 (the CLI commands)** and the **Connect API
> contracts** (the request/response shapes it sends and parses). It does **not** own the Connect API
> _implementation_, server-side spidering (dependency discovery), or the downstream DataKit
> orchestration. Those are external systems this CLI talks to over HTTP. No DataKit internals ever
> appear in CLI output or on disk.

## Contents

1. [The four-layer model](#1-the-four-layer-model)
2. [Data flow: `retrieve`](#2-data-flow-retrieve)
3. [Data flow: `deploy`](#3-data-flow-deploy)
4. [Data flow: `deploy status`](#4-data-flow-deploy-status)
5. [The "thin command" principle](#5-the-thin-command-principle)
6. [Service-layer responsibilities](#6-service-layer-responsibilities)
7. [Shared-module organization](#7-shared-module-organization)
8. [Cross-cutting concerns](#8-cross-cutting-concerns)

---

## 1. The four-layer model

The plugin is organized into four layers with a strict one-directional dependency flow. Each layer
has a single responsibility, and a layer only ever calls the layer directly beneath it.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — CLI Commands            src/commands/data-cloud/*                    │
│  oclif SfCommand subclasses. Parse flags, resolve the org connection, call ONE │
│  service function, render human output, return the result object (--json).     │
│                                                                                │
│    component-type/list.ts   component/list.ts   retrieve.ts                    │
│    deploy/index.ts          deploy/status.ts    diagnostics.ts                 │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                     │  calls one service (or, for the two read
                                     │  commands, devops-api directly)
                                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2 — Service Orchestrators   src/shared/services/*-service.ts            │
│  Own correlationId + timing, thread the diagnostic logger, map/assemble        │
│  payloads, emit telemetry on success AND failure, re-throw the original error. │
│                                                                                │
│    retrieve-service.ts   deploy-service.ts   deploy-status-service.ts          │
│    diagnostics-service.ts                                                      │
└───────────────────────┬───────────────────────────────┬────────────────────────┘
                        │                               │
                        ▼                               ▼
┌───────────────────────────────────────┐  ┌──────────────────────────────────────┐
│  LAYER 3 — Connect API Client          │  │  LAYER 4 — File I/O                   │
│  src/shared/services/devops-api.ts     │  │  src/shared/services/file-writer.ts  │
│                                        │  │  src/shared/services/file-reader.ts  │
│  Single HTTP boundary over             │  │                                      │
│  /ssot/devops/*. One conn.request()    │  │  Split the multi-component API        │
│  per function; maps raw errors to      │  │  response into one JSON file each;    │
│  structured SfErrors (toSfError).      │  │  read files back + walk dependsOn.    │
└───────────────────┬────────────────────┘  └──────────────────┬────────────────────┘
                    │  conn.request()                          │  fs read/write
                    ▼                                          ▼
        ╔═══════════════════════════╗                ┌───────────────────────────┐
        ║  Connect API  /ssot/devops ║                │  Local `data-cloud/` tree │
        ║  + spidering + DataKit     ║                │  <dataspace>/<type>/*.json │
        ║  (EXTERNAL — not owned)    ║                │  + manifest.json           │
        ╚═══════════════════════════╝                └───────────────────────────┘
```

**Where the owned boundary ends.** Layer 3 (`devops-api.ts`) is the last code this plugin owns on the
network path. Everything past the `conn.request()` call — the Connect API endpoint implementation, the
server-side spidering that resolves a component's dependency graph, and the DataKit orchestration that
executes a promotion — is external and out of scope. The `basePath()` helper
(`devops-api.ts:45`) builds the versioned prefix `/services/data/v${conn.getApiVersion()}/ssot/devops`
from the connection; the API version is never hardcoded.

### Layer-to-file map

| Layer                         | Responsibility                                                                                 | Files                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Commands**              | Flag parsing, connection resolution, one service call, output rendering                        | `src/commands/data-cloud/component-type/list.ts`, `component/list.ts`, `retrieve.ts`, `deploy/index.ts`, `deploy/status.ts`, `diagnostics.ts` |
| **2 — Service orchestrators** | correlationId/timing, payload assembly + normalization, telemetry, diagnostics, error re-throw | `src/shared/services/retrieve-service.ts`, `deploy-service.ts`, `deploy-status-service.ts`, `diagnostics-service.ts`                          |
| **3 — Connect API client**    | Single HTTP boundary; structured error mapping                                                 | `src/shared/services/devops-api.ts`                                                                                                           |
| **4 — File I/O**              | Multi-component write/split; read + transitive dependency walk                                 | `src/shared/services/file-writer.ts`, `src/shared/services/file-reader.ts`                                                                    |
| **(supporting)**              | Path derivation, diagnostics channel, types, mocks                                             | `src/shared/constants/`, `src/shared/diagnostics/`, `src/shared/types/`, `src/shared/mocks/`                                                  |

Two read commands (`component-type list`, `component list`) are so thin they call **Layer 3 directly**
and do their (trivial) shaping inline — there is no dedicated service for them. The three write/stateful
flows (`retrieve`, `deploy`, `deploy status`) each go through a Layer-2 orchestrator.

---

## 2. Data flow: `retrieve`

`sf data-cloud retrieve` fetches a named component **plus its server-resolved dependency graph** and
writes one self-describing JSON file per component into the local `data-cloud/` tree, plus a root
`manifest.json`. The command file (`retrieve.ts`) is 73 lines; its `run()` is ~19 lines and does no
orchestration.

> **Endpoint note.** The command header comment and code use `GET /ssot/devops/component/snapshot`
> (`retrieve.ts:27`, `devops-api.ts:300`). See the [conflicts note](#conflicts-found-code-vs-documentation)
> — `CLAUDE.md` lists this as `POST /ssot/devops/retrieve`. **Code is authoritative.**

```mermaid
sequenceDiagram
    actor User
    participant Cmd as retrieve.ts<br/>(Layer 1)
    participant Svc as retrieve-service.ts<br/>retrieveComponents()<br/>(Layer 2)
    participant Api as devops-api.ts<br/>getSnapshot()<br/>(Layer 3)
    participant CApi as Connect API<br/>/ssot/devops/component/snapshot<br/>(external)
    participant FW as file-writer.ts<br/>writeRetrievedComponents()<br/>(Layer 4)
    participant Disk as data-cloud/ tree

    User->>Cmd: sf data-cloud retrieve --component TYPE:NAME [--dataspace]
    Cmd->>Cmd: parse flags; conn = src-org.getConnection(api-version) (retrieve.ts:54-55)
    Cmd->>Svc: retrieveComponents(conn, component, dataspace) (retrieve.ts:59)
    Note over Svc: mint correlationId; startedAt; diag.begin(); orgId (retrieve-service.ts:60-69)
    Svc->>Svc: parseComponentFlag(component) → {type, name} (retrieve-service.ts:74)
    Svc->>Api: getSnapshot(conn, type, name, dataspace, correlationId) (retrieve-service.ts:84)
    Api->>CApi: conn.request(GET /component/snapshot?componentType&componentName[&dataSpaceName]) (devops-api.ts:299-301)
    CApi-->>Api: { components: [ root + spidered deps, each with entityPayload ] }
    Api-->>Svc: RetrieveApiResponse (errors mapped via toSfError, devops-api.ts:311)
    Svc->>FW: writeRetrievedComponents(api.components, {baseDir: cwd}) (retrieve-service.ts:90)
    loop one file per component (§5.2 layout)
        FW->>Disk: write data-cloud/<dataspace?>/<kebab-plural-type>/<name>.json (file-writer.ts:86-116)
    end
    FW->>Disk: write data-cloud/manifest.json (deploymentOrder) (file-writer.ts:117)
    FW-->>Svc: { filesWritten[], manifestPath }
    Svc->>Svc: strip entityPayload → retrievedComponents[] (retrieve-service.ts:93-98)
    Svc-->>Cmd: RetrieveResult { dataspace, targetComponent, retrievedComponents, fileWriteLocation }
    Note over Svc: void emitTelemetry(DATACLOUD_DEVOPS_RETRIEVE_COMPONENT, success:true) (retrieve-service.ts:109-118)
    Cmd->>User: log success + component list + file location (retrieve.ts:62-68)
```

**Key mechanics.**

- **Multi-component split (Layer 4).** The snapshot response is a flat `components` array (root plus
  its server-spidered dependencies). `writeRetrievedComponents` (`file-writer.ts:79-120`) resolves
  every planned file path and serialized body **up front** (`file-writer.ts:86-95`) so a bad type or
  missing payload fails before any I/O touches disk, then writes all component files concurrently
  (`file-writer.ts:116`) followed by the manifest (`file-writer.ts:117`).
- **On-disk placement.** `pathForComponent` (`file-writer.ts:50-57`) derives the folder from
  `folderForComponentType` (kebab-case + pluralize, `component-paths.ts:78-87`) and routes
  dataspace-agnostic / dataspace-less components to the `data-cloud/` root via `isRootRouted`
  (`component-paths.ts:102-104`). Files are 2-space-indented JSON with a trailing newline
  (`file-writer.ts:60-62`).
- **Payload stripping.** The service never returns raw payloads: it maps each component down to
  `{ componentType, componentName, dataspaceName, dependsOn }` (`retrieve-service.ts:93-98`), so neither
  the return object nor `--json` output carries `entityPayload`.

---

## 3. Data flow: `deploy`

`sf data-cloud deploy` reads the named component **and its transitive dependencies** back off disk,
walks the `dependsOn` graph, assembles a single request body, and POSTs it. The command
(`deploy/index.ts`) is 72 lines; its `run()` is ~17 lines. `--dataspace` is **required** here (unlike
`retrieve`, where it is optional) and there is no `target-org` alias.

> **Endpoint note.** Code uses `POST /ssot/devops/component/promotion` (`deploy/index.ts:27`,
> `devops-api.ts:355`) with body `{ components: [...] }` (`devops-api.ts:356`). `CLAUDE.md` lists
> `POST /ssot/devops/deploy`. **Code is authoritative.**

```mermaid
sequenceDiagram
    actor User
    participant Cmd as deploy/index.ts<br/>(Layer 1)
    participant Svc as deploy-service.ts<br/>deployComponents()<br/>(Layer 2)
    participant FR as file-reader.ts<br/>(Layer 4)
    participant Disk as data-cloud/ tree
    participant Api as devops-api.ts<br/>createPromotion()<br/>(Layer 3)
    participant CApi as Connect API<br/>/ssot/devops/component/promotion<br/>(external)

    User->>Cmd: sf data-cloud deploy --component TYPE:NAME --dataspace DS --target-org ORG
    Cmd->>Cmd: parse flags; conn = target-org.getConnection(api-version) (deploy/index.ts:55-56)
    Cmd->>Svc: deployComponents(conn, component, dataspace) (deploy/index.ts:59)
    Note over Svc: mint correlationId; startedAt; diag.begin(); orgId (deploy-service.ts:96-105)
    Svc->>Svc: parseComponentFlag(component) → {type, name} (deploy-service.ts:111)
    Svc->>FR: readComponentFile(type, name, dataspace, {baseDir}) (deploy-service.ts:121)
    FR->>Disk: read root file (root path first, then dataspace path) (file-reader.ts:91-160)
    Disk-->>FR: ComponentFile (validated: required fields present) (file-reader.ts:150-157)
    Svc->>FR: collectTransitiveDependencies([root], dataspace, {baseDir}) (deploy-service.ts:122)
    loop depth-first over dependsOn (dedup + cycle-safe)
        FR->>Disk: read each dependency file (file-reader.ts:192-216)
    end
    FR-->>Svc: ComponentFile[] (roots + all transitive deps)
    Svc->>Svc: assembleDeployRequest(allComponents) → bare array, payloads verbatim (deploy-service.ts:126, 68-76)
    Svc->>Api: createPromotion(conn, request, correlationId) (deploy-service.ts:134)
    Api->>CApi: conn.request(POST /component/promotion, body {components: request}) (devops-api.ts:353-359)
    CApi-->>Api: { status: 'SUBMITTED', jobId } (async submission ack)
    Api-->>Svc: DeployApiResponse (errors mapped via toSfError, devops-api.ts:367)
    Svc-->>Cmd: DeployResult { jobId, status } (deploy-service.ts:136-139)
    Note over Svc: void emitTelemetry(DATACLOUD_DEVOPS_DEPLOY_COMPONENT, success:true, lifecycleStatus) (deploy-service.ts:146-156)
    Cmd->>User: log submitted + status + jobId + "poll with deploy status" (deploy/index.ts:63-67)
```

**Key mechanics.**

- **Transitive dependency walk (Layer 4).** `collectTransitiveDependencies` (`file-reader.ts:173-228`)
  seeds the roots into a `visited` set (`file-reader.ts:222-224`), then depth-first, concurrently reads
  each `dependsOn` edge, deduplicating by `"type:name"` (`file-reader.ts:194-198`). The dedup is
  race-free because a key is added to `visited` synchronously **before** its `await`
  (`file-reader.ts:197-198`). A missing dependency file raises a structured `DependencyNotFoundError`
  (`file-reader.ts:204-210`) telling the user to run `retrieve` first.
- **Candidate-path resolution.** `readComponentFile` tries the **root path first, then the dataspace
  path** (`file-reader.ts:97-101`, `candidatePaths` at `72-82`), so a component stored without a
  dataspace is still found when a dataspace context is passed. Paths are derived by the **same**
  `folderForComponentType` the writer uses (`file-reader.ts:57`), guaranteeing the reader looks exactly
  where the writer wrote.
- **Payloads carried verbatim.** `assembleDeployRequest` (`deploy-service.ts:68-76`) produces a bare
  array of `{ componentType, componentName, dataspaceName, dependsOn, entityPayload }`, never
  re-parsing `entityPayload` (a string stays a string, an object stays an object). The HTTP boundary
  wraps that array as `{ components: request }` (`devops-api.ts:356`).
- **The backend returns a `jobId`.** The synchronous response is a submission ack; the service reads
  `api.jobId` and `api.status` (`deploy-service.ts:136-139`) and surfaces the jobId to the user for
  polling.

---

## 4. Data flow: `deploy status`

`sf data-cloud deploy status --job-id <id>` polls an async promotion job and reports the overall
status plus a per-component status table. The command (`deploy/status.ts`) is 90 lines; its `run()` is
~40 lines (most of it output/table rendering, not orchestration).

> **Endpoint note.** Code uses `GET /ssot/devops/component/promotion/{jobId}` (`deploy/status.ts:27`,
> `devops-api.ts:402`). `CLAUDE.md` lists `GET /ssot/devops/deploy/{jobId}/status`. **Code is
> authoritative.**

```mermaid
sequenceDiagram
    actor User
    participant Cmd as deploy/status.ts<br/>(Layer 1)
    participant Svc as deploy-status-service.ts<br/>checkDeployStatus()<br/>(Layer 2)
    participant Api as devops-api.ts<br/>getPromotionStatus()<br/>(Layer 3)
    participant CApi as Connect API<br/>/ssot/devops/component/promotion/{jobId}<br/>(external)

    User->>Cmd: sf data-cloud deploy status --job-id ID --target-org ORG
    Cmd->>Cmd: parse flags; conn = target-org.getConnection(api-version) (deploy/status.ts:50-51)
    Cmd->>Svc: checkDeployStatus(conn, job-id) (deploy/status.ts:54)
    Note over Svc: mint correlationId; startedAt; diag.begin(); orgId (deploy-status-service.ts:102-111)
    Svc->>Api: getPromotionStatus(conn, jobId, correlationId) (deploy-status-service.ts:115)
    Api->>CApi: conn.request(GET /component/promotion/{encodeURIComponent(jobId)}) (devops-api.ts:401-403)
    CApi-->>Api: { jobId, status: PascalCase, components:[{status: PascalCase, error?}] }
    Api-->>Svc: DeployStatusApiResponse (errors mapped via toSfError, devops-api.ts:412)
    Svc->>Svc: normalize per-component status → toComponentStatus() (deploy-status-service.ts:117-123)
    Svc->>Svc: normalize job status → toLifecycleStatus() PascalCase→UPPERCASE (deploy-status-service.ts:127)
    Svc-->>Cmd: DeployStatusResult { jobId, status, components[] } (raw 'SUCCESS' kept)
    Note over Svc: void emitTelemetry(DEPLOY_STATUS_POLL) + one DEPLOY_COMPONENT_FAILURE per failed comp (deploy-status-service.ts:132-171)
    Cmd->>Cmd: display map 'SUCCESS' → 'SUCCEEDED' (display only) (deploy/status.ts:60, 68)
    Cmd->>User: log jobId + status; render table if components.length > 0; print failure reasons (deploy/status.ts:59-85)
```

**Key mechanics.**

- **PascalCase → UPPERCASE normalization lives in the service seam.** The Connect API returns
  PascalCase enums (`Success`, `Failed`, `Created`, `InProgress`); `toLifecycleStatus`
  (`deploy-status-service.ts:48-60`) folds them to the CLI's UPPERCASE `DeploymentLifecycleStatus`, and
  any unknown/unexpected value defaults to `INPROGRESS` (non-terminal) so a poll never reports a false
  terminal state. `toComponentStatus` (`deploy-status-service.ts:67-78`) does the same for per-component
  status (including the never-emitted `Pending` → `INPROGRESS`). Keeping the mapping here means the
  command and the HTTP boundary both stay agnostic of wire casing.
- **`SUCCESS` vs `SUCCEEDED` is display-only.** The returned object (and `--json`) preserves the raw
  contract value `'SUCCESS'`; the command maps it to the friendlier `'SUCCEEDED'` **only for display**
  in the status line (`deploy/status.ts:60`) and the table (`deploy/status.ts:68`).
- **Terminal-failure classification.** On a terminal `FAILED`, `deriveDeployErrorCode`
  (`deploy-status-service.ts:87-89`) emits a machine-parseable code — `ComponentValidationError` when a
  specific component failed, else `DeployJobFailed` — for agent/CI consumers.
- **Structured failure output.** The table is rendered only when there are components
  (`deploy/status.ts:63`); per-failed-component reasons are surfaced in a structured
  header + reason block (`deploy/status.ts:79-85`).

---

## 5. The "thin command" principle

Commands are deliberately thin: parse flags → resolve the connection → call **one** service function →
render output → return the result object. No orchestration, HTTP, file I/O, telemetry, or error mapping
lives in a command. This keeps the CLI surface easy to test (the result object is what `--json` emits
and what unit tests assert against) and lets all behavior evolve in the service layer.

Here is the entire `run()` body of `deploy/index.ts` (`deploy/index.ts:54-71`), verbatim — the single
`await deployComponents(...)` at line 59 is the only line that does work:

```ts
public async run(): Promise<DeployResult> {
  const { flags } = await this.parse(DataCloudDeploy);
  const conn = flags['target-org'].getConnection(flags['api-version']);

  // Service layer: parse the flag → read local files → walk deps → assemble the payload → POST.
  const result = await deployComponents(conn, flags.component, flags.dataspace);

  // Human-readable output (auto-suppressed when --json is present). The live response is a
  // submission ack ('SUBMITTED') plus the tracking jobId the backend always returns.
  this.log(messages.getMessage('info.submitted', [flags.component, flags.dataspace]));
  this.log(messages.getMessage('info.status', [result.status]));
  this.log(messages.getMessage('info.jobId', [result.jobId]));
  this.log('');
  this.log(messages.getMessage('info.statusNote', [result.jobId]));

  // Returned object is what --json emits and what unit tests assert against.
  return result;
}
```

Every command follows this shape. Actual file sizes (total lines, most of which are the license header,
flag definitions, and output rendering — not logic):

| Command               | File                     | Lines | `run()` shape                                                 |
| --------------------- | ------------------------ | ----- | ------------------------------------------------------------- |
| `component-type list` | `component-type/list.ts` | 67    | calls `getComponentTypes` (Layer 3) directly, maps to a table |
| `component list`      | `component/list.ts`      | 81    | calls `getComponents` (Layer 3) directly, renders a table     |
| `retrieve`            | `retrieve.ts`            | 73    | one `retrieveComponents()` call, then logs the file list      |
| `deploy`              | `deploy/index.ts`        | 72    | one `deployComponents()` call, then logs the jobId            |
| `deploy status`       | `deploy/status.ts`       | 90    | one `checkDeployStatus()` call, then renders a table          |

The two read-only list commands are thin enough to skip a dedicated service and call the Layer-3 client
directly; the three stateful flows each delegate to a Layer-2 orchestrator.

---

## 6. Service-layer responsibilities

Each stateful command has a matching orchestrator in `src/shared/services/*-service.ts`. Beyond calling
the HTTP client and the file layer, every orchestrator carries the same cross-cutting bookkeeping so no
single command has to. The responsibilities are:

- **Orchestration** — parse the `TYPE:NAME` flag (`parseComponentFlag`, shared, `deploy-service.ts:47-59`),
  fan out to Layer 3 (`devops-api`) and/or Layer 4 (`file-reader`/`file-writer`), and assemble/normalize
  the payload.
- **Correlation + timing** — mint a `correlationId = randomUUID()` and record `startedAt = Date.now()`
  once per call; both are attached to telemetry and (once the header gate is enabled) to the request.
- **Diagnostics threading** — obtain the local NDJSON logger and bind the command + correlationId with
  `getDiagLogger().begin({ command, correlationId })`, then emit phase events (`info`/`debug`/`trace`/`error`).
- **Telemetry emission** — emit exactly one primary event on **both** success and failure, fire-and-forget
  (`void emitTelemetry(...)`), so telemetry is off the latency path and can never alter the result.
- **Error re-throw** — on failure, emit the failure telemetry + diagnostic event, then `throw err` to
  re-throw the **original** error object so propagation and the error the user sees are unchanged.
- **`orgId` threading** — compute `safeOrgId(conn)` once (guarded; never throws) and reuse it across all
  diagnostic and telemetry events.

The common skeleton, distilled from `retrieveComponents` (`retrieve-service.ts:52-151`),
`deployComponents` (`deploy-service.ts:88-190`), and `checkDeployStatus`
(`deploy-status-service.ts:99-195`):

```ts
export async function <verb>Components(conn, ...args): Promise<...Result> {
  const startedAt = Date.now();
  const correlationId = randomUUID();
  const diag = getDiagLogger().begin({ command: 'data-cloud <verb>', correlationId });
  const orgId = safeOrgId(conn);
  let componentType = 'unknown';           // bounded TYPE only; set after parse. Never the name.
  let componentCount = 0;
  try {
    // 1. parse the flag, set componentType = safeComponentType(parsed.componentType)
    // 2. call devops-api (Layer 3) and/or file-reader/file-writer (Layer 4)
    // 3. build the standardized Result object (payloads stripped for retrieve)
    void emitTelemetry('DATACLOUD_DEVOPS_<VERB>_<NOUN>', {
      correlationId, componentType, ...(orgId && { orgId }),
      success: true, /* counts, durationMs: Date.now() - startedAt, ... */
    });
    diag.info(Subsystem.<X>, '<CODE>', '...', { duration_ms: Date.now() - startedAt, /* ... */ });
    return result;
  } catch (err) {
    const errorMessage = errorMessageFrom(err);
    const gackId = extractGackId(errorMessage);
    void emitTelemetry('DATACLOUD_DEVOPS_<VERB>_<NOUN>', {
      correlationId, componentType, ...(orgId && { orgId }),
      success: false, durationMs: Date.now() - startedAt,
      errorCode: err instanceof SfError ? err.code : 'UnexpectedError',
      ...(errorMessage && { errorMessage }), ...(gackId && { gackId }),
    });
    diag.error(Subsystem.<X>, '<CODE>_ERR', '...', { /* ...same fields..., err */ });
    throw err;   // re-throw the ORIGINAL error object — propagation unchanged.
  }
}
```

**Error mapping is at Layer 3, not the service.** The structured, actionable error mapping lives in
`toSfError` (`devops-api.ts:89-127`), which turns a raw jsforce/connection failure into one of four
codes with actionable messages:

| Code                        | Trigger                                                            | Actions surfaced to the user                           |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| `DataCloudApiNetworkError`  | `DomainNotFoundError` / `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` | check network + instance URL reachability              |
| `DataCloudApiAuthError`     | `INVALID_SESSION_ID` / `ERROR_HTTP_401`                            | re-authenticate with `sf org login web`                |
| `DataCloudApiNotFoundError` | `NOT_FOUND` / `ERROR_HTTP_404`                                     | confirm Data Cloud enabled; verify type/name/dataspace |
| `DataCloudApiError`         | anything else                                                      | generic "Failed to `<op>`" with the underlying message |

The service captures the mapped code for telemetry (`err instanceof SfError ? err.code : 'UnexpectedError'`)
and re-throws the original object so the CLI's standard error rendering shows the actionable message.
Deploy-status is the one place a service also emits a **derived** classification
(`deriveDeployErrorCode`, `deploy-status-service.ts:87-89`) for terminal job failures.

---

## 7. Shared-module organization

Everything under `src/shared/` is layered code shared across commands. The directory names map to the
layers and cross-cutting concerns above.

```
src/shared/
├── services/            Layers 2, 3, 4 — all orchestration, HTTP, and file I/O
│   ├── retrieve-service.ts        (L2) retrieve orchestrator
│   ├── deploy-service.ts          (L2) deploy orchestrator + parseComponentFlag + assembleDeployRequest
│   ├── deploy-status-service.ts   (L2) status orchestrator + PascalCase→UPPERCASE mappers
│   ├── diagnostics-service.ts     (L2) diagnostics-bundle orchestrator (for the diagnostics command)
│   ├── devops-api.ts              (L3) single HTTP boundary over /ssot/devops/* + toSfError
│   ├── file-writer.ts             (L4) API response → one JSON file per component + manifest
│   ├── file-reader.ts             (L4) disk → ComponentFile + transitive dependency walk
│   └── telemetry.ts               (cross-cutting) the single emitTelemetry chokepoint + safe-field helpers
├── diagnostics/         The local NDJSON diagnostic channel (separate from telemetry)
│   ├── event.ts                   LogLevel + Subsystem enums, DiagEvent row schema
│   ├── logger.ts                  DiagLogger + FileSink; getDiagLogger() singleton
│   ├── config.ts                  env-var-driven level resolution
│   ├── redact.ts                  deep redaction before write
│   ├── storage.ts                 log-dir resolution + rotation (size/count/age)
│   ├── plugin-version.ts          version stamp for each row
│   └── tar-writer.ts              bundling for the diagnostics command
├── constants/
│   └── component-paths.ts         folderForComponentType (kebab+pluralize), isRootRouted, ROOT_DIR, MANIFEST_FILE
├── types/               Per-flow TypeScript contracts (request/response/result/file shapes)
│   ├── component-type.ts  component.ts  retrieve.ts  deploy.ts  deploy-status.ts
│   ├── file-layout.ts  diagnostics.ts
└── mocks/               Offline fixtures for tests / local dev
    ├── component-types.mock.ts  components.mock.ts  retrieve.mock.ts
    ├── retrieve-api-response.mock.ts  deploy.mock.ts
```

**Dependency direction (enforced by convention).**

- Commands import **services and types**; commands never import each other.
- Services import Layer-3/Layer-4 peers, `constants/`, `diagnostics/`, `types/`, and `telemetry.ts`;
  services never import commands. (E.g. `retrieve-service.ts` imports `deploy-service.ts`'s
  `parseComponentFlag` — `retrieve-service.ts:23` — reusing the validated parser, but the flow is
  strictly service→service, never up into a command.)
- `constants/component-paths.ts` is the **single source of truth** for on-disk path derivation, imported
  by **both** `file-writer.ts` and `file-reader.ts` so writes and reads agree by construction. It imports
  nothing but `@salesforce/core` (for `SfError`).
- `diagnostics/event.ts` imports nothing and runs nothing at load time — importing it is always
  side-effect free (`event.ts:23-24`).
- `types/` are pure type declarations; `mocks/` are leaf fixtures no production path depends on.

---

## 8. Cross-cutting concerns

Two **independent** observability channels run alongside every command. They never share code paths, and
diagnostics never routes through `emitTelemetry` (`event.ts:23-25`).

### Telemetry — aggregate metrics via the Lifecycle channel

`telemetry.ts` is the single chokepoint. `emitTelemetry` (`telemetry.ts:114-126`) emits on the shared
`Lifecycle.getInstance().emitTelemetry({ eventName, surface: 'cli', ...attributes })` channel; the sf
CLI's own telemetry infrastructure (not this plugin) subscribes, enriches, and uploads. Three guarantees
are centralized here so they cannot drift:

1. **Never throw / never block** — the body is `try/caught` and callers use `void`, so a listener or emit
   failure can never alter a command's return value or error propagation (`telemetry.ts:115-125`). Emitting
   with no registered listener is a safe no-op in `@salesforce/core`.
2. **Naming** — every event name is a `DATACLOUD_DEVOPS_<VERB>_<NOUN>` constant passed through this
   function (e.g. `DATACLOUD_DEVOPS_RETRIEVE_COMPONENT`, `DATACLOUD_DEVOPS_DEPLOY_COMPONENT`,
   `DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL`, `DATACLOUD_DEVOPS_API_REQUEST`, and the
   `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` sub-event).
3. **Safe fields only** — `TelemetryAttributes` is a flat map of primitives (`telemetry.ts:34`), so a
   caller cannot attach a nested object or a raw API body.

**Redaction / safe-field helpers** (all in `telemetry.ts`):

- `safeComponentType` (`telemetry.ts:50-56`) bounds a component type by **shape** (a length-limited,
  separator-free identifier) rather than a catalog, collapsing anything path-like or with `@`/`:`/`.`/
  hyphen/space to the literal `'other'`. This is why free-text `--component` / `--component-type` values
  can never leak a path or email into telemetry, while a genuine new backend type still reports faithfully.
- `safeOrgId` (`telemetry.ts:65-71`) returns the `00D…` org id, guarded so it never throws; callers spread
  it conditionally (`...(orgId && { orgId })`) so a missing id is omitted rather than sent as a placeholder.
- `errorMessageFrom` (`telemetry.ts:79-82`) attaches the raw mapped error message **on error paths only**
  (a deliberate June 2026 decision for debuggability, correlated by `orgId`).
- `extractGackId` (`telemetry.ts:98-101`) is **shipped disabled** (`GACK_EXTRACTION_ENABLED = false`,
  `telemetry.ts:94`); it always returns `undefined` until the backend confirms whether the API surfaces a
  gack id, keeping false-positive ids out of telemetry.

The one place telemetry carries a component **name** is the `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE`
sub-event (`deploy-status-service.ts:158-171`) — a scoped, deliberate relaxation for production debugging
of failed components; every other event stays bounded.

> **Where CLI telemetry actually lands.** These Lifecycle events are picked up by the sf CLI's telemetry
> pipeline, which forwards to **Azure App Insights** — not Splunk. See the
> [conflicts note](#conflicts-found-code-vs-documentation).

### Diagnostics — a local NDJSON debug log (independent of telemetry)

The `diagnostics/` module is a **passive observer** that writes richer, nested, correlatable NDJSON to a
rotating on-disk file for debugging a single run (`logger.ts:25-39`). It is obtained lazily inside a
function via `getDiagLogger()` (`logger.ts:238-250`) and bound per-invocation with `.begin({ command,
correlationId })`, reusing the orchestrator's `correlationId` so on-disk logs join to the telemetry events
by one id.

- **On by default at INFO** — `DEFAULT_LEVEL = LogLevel.INFO` (`event.ts:55`); `DEBUG`/`TRACE` are opt-in
  per-subsystem env vars (`SF_DATACLOUD_LOG_LEVEL_API` / `_DEPLOY` / `_FILEIO`, `event.ts:41-44`). A
  disabled channel is a permanent no-op that opens no file (`logger.ts:243-245`).
- **Never throws / never blocks** — every write is a synchronous `appendFileSync` wrapped in `try/catch`
  (`logger.ts:162-176`); an unwritable disk or redaction failure is swallowed. Hot loops gate on
  `debugEnabled`/`traceEnabled` (`logger.ts:127-134`) so `extra` is never built when it would be dropped.
- **Redaction + tiered privacy** — every value passes through `redact`/`redactString` before hitting disk
  (`logger.ts:191-213`, `redact.ts`); raw names/paths only reach the log at DEBUG/TRACE. The NDJSON row
  schema (`DiagEvent`, `event.ts:93-118`) uses snake_case field names deliberately, matching the remote
  telemetry field names so a support engineer greps the local log with the same names they see in App
  Insights.
- **Bounded on disk** — an in-memory byte counter drives rotation to `.N.ndjson` slots
  (`logger.ts:97-101`); a one-time maintenance pass prunes/gzips stale files (`logger.ts:85-90`, `storage.ts`).

The `sf data-cloud diagnostics` command bundles these local logs (via `diagnostics-service.ts` and
`diagnostics/tar-writer.ts`) so a user can attach them to a bug report.

### Correlation IDs across layers

Each orchestrator mints one `correlationId` (`randomUUID()`) and threads it (a) into telemetry, (b) into
the bound diagnostic logger, and (c) down through Layer 3 as an argument. Layer 3 is **wired to send it as
a request header but ships with that gate off**: `SEND_CORRELATION_HEADER = false` (`devops-api.ts:58`),
so every request is built byte-for-byte as today — a bare URL string for GETs (`getRequest`,
`devops-api.ts:76-81`) and `Content-Type` only for the POST, into which `correlationHeaders(correlationId)`
(`devops-api.ts:65-68`) currently spreads `{}` (`devops-api.ts:358`). The header **name**
(`CORRELATION_ID_HEADER = 'x-correlation-id'`, `devops-api.ts:57`) is a placeholder pending confirmation
of the header the Connect API actually reads. Flipping the flag and setting the real name is the only
remaining step to achieve full CLI → Connect API → DataKit correlation.

For deeper treatment of these two channels, see `docs/TELEMETRY.md` and `docs/DIAGNOSTICS.md` (companion
documents).

---

## Conflicts found (code vs. documentation)

The following are places where the code as written diverges from `CLAUDE.md` / `PROJECT_KNOWLEDGE.md`.
**Code is treated as the source of truth throughout this document**; these are flagged so the reference
docs can be reconciled.

1. **Endpoint paths.** `CLAUDE.md`'s command table lists `POST /ssot/devops/retrieve`,
   `POST /ssot/devops/deploy`, `GET /ssot/devops/deploy/{jobId}/status`, and
   `GET …/component-object-api-names`. The code uses **`GET /ssot/devops/component/snapshot`**
   (`devops-api.ts:300`), **`POST /ssot/devops/component/promotion`** (`devops-api.ts:355`),
   **`GET /ssot/devops/component/promotion/{jobId}`** (`devops-api.ts:402`), and
   **`GET …/component/catalog`** (`devops-api.ts:222`). Only `GET …/component-types`
   (`devops-api.ts:147`) matches.
2. **Retrieve verb.** `CLAUDE.md` implies `retrieve` is a POST; the code implements it as a **GET** to the
   snapshot endpoint (`retrieve.ts:27`, `devops-api.ts:299`).
3. **Command count.** `CLAUDE.md` documents "the five commands"; the code ships a **sixth**,
   `sf data-cloud diagnostics` (`src/commands/data-cloud/diagnostics.ts`), plus the generator's leftover
   `hello/world.ts`.
4. **Node version.** `CLAUDE.md` says Node **v24**; `package.json` declares `"engines": { "node": ">=18.0.0" }`.
5. **Telemetry destination.** `CLAUDE.md` says structured logs go to **Splunk**; CLI telemetry emitted on
   the Lifecycle channel is picked up by the sf CLI and lands in **Azure App Insights**, not Splunk. (The
   local diagnostics NDJSON channel is on-disk only; no CLI→Splunk forwarder exists.)
6. **`SUCCESS` vs `SUCCEEDED`.** The returned/`--json` value is the raw contract enum **`SUCCESS`**
   (`deploy-status-service.ts:51`); the friendlier **`SUCCEEDED`** exists only as a display mapping in the
   command (`deploy/status.ts:60,68`).
7. **Stale JSDoc in `deploy-service.ts`.** The function doc says "The live backend returns only
   `{ status: 'SUBMITTED' }` (no jobId yet)" (`deploy-service.ts:81`), but the code reads and returns
   `api.jobId` (`deploy-service.ts:137`) and the inline comment at `:135` says the backend "always returns
   a tracking jobId." The doc comment is stale; the code is correct.
8. **Component-failure telemetry location.** The `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` sub-event is
   emitted from **`deploy-status-service.ts`** (`:161`), not from `deploy-service.ts` — failure detail is
   only known at poll time, not submission time.
9. **Disabled-by-design gates.** Two features are wired but shipped **off**: the CLI→backend correlation
   header (`SEND_CORRELATION_HEADER = false`, `devops-api.ts:58`) and gack-id extraction
   (`GACK_EXTRACTION_ENABLED = false`, `telemetry.ts:94`). Both are intentional placeholders pending backend
   confirmation, not bugs.
10. **Referenced companion docs.** This document points to `docs/TELEMETRY.md` and `docs/DIAGNOSTICS.md`;
    both are present in `docs/` alongside this file and the other companion documents
    (`ADDING_A_COMMAND.md`, `ERROR_HANDLING.md`, `ON_DISK_FORMAT.md`).
