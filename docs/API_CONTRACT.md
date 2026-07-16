# API Contract — Connect API Integration

> **Audience:** a new engineer picking up `@salesforce/plugin-datacloud-devops` with zero prior context.
> **Scope of this doc:** the exact HTTP contract between the CLI and the Data Cloud (Data 360) DevOps
> Connect API — base path, every endpoint, the request/response shapes, the TypeScript types that
> model them, authentication, error mapping, correlation, and the two normalizations the client
> performs on the wire.

## Contents

1. [What the CLI owns (and does not)](#1-what-the-cli-owns-and-does-not)
2. [Base path construction](#2-base-path-construction)
3. [The five endpoints](#3-the-five-endpoints)
4. [Type definitions](#4-type-definitions)
5. [Authentication](#5-authentication)
6. [Error mapping](#6-error-mapping)
7. [Correlation header](#7-correlation-header)
8. [Deploy body contract (`{ components: [...] }`)](#8-deploy-body-contract--components--)
9. [PascalCase → UPPERCASE enum normalization](#9-pascalcase--uppercase-enum-normalization)
10. [Appendix: contract-vs-docs discrepancies](#appendix-contract-vs-docs-discrepancies)

Cross-references: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (layering, command→service→HTTP flow),
[`docs/ERROR_HANDLING.md`](ERROR_HANDLING.md) (the four structured error codes in depth),
[`docs/ON_DISK_FORMAT.md`](ON_DISK_FORMAT.md) (the file layout the deploy body is assembled from).

---

## 1. What the CLI owns (and does not)

This project is a **thin client**. It is one process in a three-layer system, and it owns only the
top two:

| Layer                                                                | Responsibility                                                                                                                                              | Owned here?                                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Layer 1 — CLI**                                                    | The `sf data-cloud …` commands, the service/orchestration seam, on-disk file layout, telemetry, error mapping.                                              | ✅ Yes                                                       |
| **Layer 2 — Connect API contracts**                                  | The request/response _representation_ shapes (mirrored in TypeScript in `src/shared/types/*`, and in the backend's `…InputRepresentation`/`…Enum` classes). | ✅ Yes (the contract)                                        |
| **Layer 3 — Connect API implementation + spidering + orchestration** | Actually executing the endpoints, resolving a component's dependency graph server-side, and applying it to the org.                                         | ❌ **No — external, owned by a separate backend developer.** |

**Consequence for this doc:** everything below describes what the CLI _sends_ and what it _expects
back_. The CLI does not implement any of these endpoints. The server-side dependency resolution
("spidering") that populates `dependsOn` and the deployment order happens entirely in Layer 3 and is
opaque to the CLI.

> **Internal payloads are never surfaced.** Each component carries a type-specific `entityPayload`
> that the CLI treats as an **opaque, pass-through blob** — it is written to disk verbatim on
> retrieve and sent back verbatim on deploy, and it is never parsed, reformatted, or logged. The CLI
> deliberately exposes none of the backend's internal orchestration objects, template names, or
> encoded definition XML in its output or in files on disk.

---

## 2. Base path construction

Every request is built from one helper. There is exactly one definition, and it is the only place a
URL is rooted:

```ts
// src/shared/services/devops-api.ts:45
/** Builds the versioned `ssot/devops` base path from the connection's resolved API version. */
const basePath = (conn: Connection): string => `/services/data/v${conn.getApiVersion()}/ssot/devops`;
```

[`devops-api.ts:45`](../src/shared/services/devops-api.ts#L45)

So a fully-formed URL looks like:

```
/services/data/v63.0/ssot/devops/component-types
└──────────────┬─────────────┘└───────┬───────┘
   versioned services root       endpoint path
```

**The API version is never hardcoded.** It is resolved at request time from the live
`Connection` via [`conn.getApiVersion()`](../src/shared/services/devops-api.ts#L45). The connection's
version, in turn, comes from the org (or from the optional `--api-version` flag — see
[§5](#5-authentication)). Rationale:

- A hardcoded `v63.0` would silently pin the plugin to one release and rot; resolving from the
  connection means the plugin tracks whatever API version the target org negotiates.
- It keeps a single source of truth. `Connection.request` (the underlying jsforce call) resolves the
  request against the org's instance URL, so the CLI only ever supplies the **path**, never a host.

There is no other string interpolation of the version anywhere in the client — grep-confirm with
`getApiVersion`.

---

## 3. The five endpoints

All five live in the single HTTP-boundary module
[`src/shared/services/devops-api.ts`](../src/shared/services/devops-api.ts). Each exported function
is one `conn.request(...)` call, translates low-level errors via `toSfError` (see [§6](#6-error-mapping)),
and returns the raw wire type. **The endpoint _paths_ in the code differ from the older names in
`CLAUDE.md`; the code is authoritative — see the [discrepancy table](#appendix-contract-vs-docs-discrepancies).**

| #   | CLI command                      | Method | Path (appended to base)                                                 | Function                                                          |
| --- | -------------------------------- | ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | `data-cloud component-type list` | `GET`  | `/component-types`                                                      | [`getComponentTypes`](../src/shared/services/devops-api.ts#L132)  |
| 2   | `data-cloud component list`      | `GET`  | `/component/catalog?componentType=…[&dataSpaceName=…]`                  | [`getComponents`](../src/shared/services/devops-api.ts#L196)      |
| 3   | `data-cloud retrieve`            | `GET`  | `/component/snapshot?componentType=…&componentName=…[&dataSpaceName=…]` | [`getSnapshot`](../src/shared/services/devops-api.ts#L274)        |
| 4   | `data-cloud deploy`              | `POST` | `/component/promotion`                                                  | [`createPromotion`](../src/shared/services/devops-api.ts#L337)    |
| 5   | `data-cloud deploy status`       | `GET`  | `/component/promotion/{jobId}`                                          | [`getPromotionStatus`](../src/shared/services/devops-api.ts#L387) |

> `data-cloud diagnostics` is a **local-only** command (it bundles on-disk diagnostic logs). It makes
> **no** Connect API call and therefore is not in this table.

The rest of this section documents each endpoint end-to-end.

### 3.1 `GET /component-types` — list supported component types

- **Command:** `sf data-cloud component-type list`
- **Function:** [`getComponentTypes(conn, correlationId?)`](../src/shared/services/devops-api.ts#L132)
- **Query params:** none.
- **Request:** built via `getRequest(...)` — today a bare URL string ([§7](#7-correlation-header)):
  ```ts
  // devops-api.ts:146-148
  const resp = await conn.request<ComponentTypesResponse>(
    getRequest(`${basePath(conn)}/component-types`, correlationId)
  );
  ```
  [`devops-api.ts:146`](../src/shared/services/devops-api.ts#L146)
- **Response type:** [`ComponentTypesResponse`](../src/shared/types/component-type.ts#L25) — a map of
  `componentType` value → display label.
- **Real response shape** (matches the `component-types` mock verbatim,
  [`component-types.mock.ts:28`](../src/shared/mocks/component-types.mock.ts#L28)):
  ```json
  {
    "supportedComponentTypes": {
      "DataConnection": "Data Connection",
      "DataStreamBundle": "Data Stream",
      "CalculatedInsight": "Calculated Insight",
      "DataLakeObject": "Data Lake Object",
      "DataTransform": "Data Transform",
      "IdentityResolution": "Identity Resolution",
      "DataGraph": "Data Graph"
    }
  }
  ```
- **CLI output type:** the command flattens this to
  [`ComponentTypeListResult`](../src/shared/types/component-type.ts#L38).

### 3.2 `GET /component/catalog` — list components of a type

- **Command:** `sf data-cloud component list --component-type CalculatedInsight [--dataspace default]`
- **Function:** [`getComponents(conn, componentType, dataSpaceName?, correlationId?)`](../src/shared/services/devops-api.ts#L196)
- **Query params:**
  | Param | Required | Notes |
  | ----- | -------- | ----- |
  | `componentType` | ✅ | API value, e.g. `CalculatedInsight`. |
  | `dataSpaceName` | optional | **Omitted entirely** when absent or blank — the client never sends `dataSpaceName=undefined`. When omitted, the backend lists against the org's default dataspace context. |

  ```ts
  // devops-api.ts:211-215
  const params: Record<string, string> = { componentType };
  if (dataSpaceName?.trim()) {
    params.dataSpaceName = dataSpaceName;
  }
  const qs = new URLSearchParams(params).toString();
  ```

  [`devops-api.ts:211`](../src/shared/services/devops-api.ts#L211)

- **Response type:** [`ComponentsResponse`](../src/shared/types/component.ts#L31):
  ```json
  {
    "components": [{ "componentName": "HighValueCustomers" }, { "componentName": "custom_ci" }]
  }
  ```
- **CLI output type:** [`ComponentListResult`](../src/shared/types/component.ts#L36).

> **Note on the query-param casing.** The param on the wire is `dataSpaceName` (capital `S`), while
> the on-disk field and the `--dataspace` flag are lower-case `dataspace`/`dataspaceName`. That is
> intentional — the wire name mirrors the backend contract; the CLI vocabulary is `dataspace`.

### 3.3 `GET /component/snapshot` — retrieve a component + its dependency graph

- **Command:** `sf data-cloud retrieve --component CalculatedInsight:highValueCustomer [--dataspace default] --src-org my-org`
- **Function:** [`getSnapshot(conn, componentType, componentName, dataSpaceName?, correlationId?)`](../src/shared/services/devops-api.ts#L274)
- **Query params:**
  | Param | Required | Notes |
  | ----- | -------- | ----- |
  | `componentType` | ✅ | e.g. `CalculatedInsight`. |
  | `componentName` | ✅ | e.g. `highValueCustomer`. |
  | `dataSpaceName` | optional | Same omit-when-blank rule as `component/catalog`. |
  ```ts
  // devops-api.ts:288-292
  const params: Record<string, string> = { componentType, componentName };
  if (dataSpaceName?.trim()) {
    params.dataSpaceName = dataSpaceName;
  }
  const qs = new URLSearchParams(params).toString();
  ```
  [`devops-api.ts:288`](../src/shared/services/devops-api.ts#L288)
- **Response type:** [`RetrieveApiResponse`](../src/shared/types/retrieve.ts#L84) — the requested
  component **plus its server-spidered, deployment-ordered dependency graph**, each element carrying
  its raw `entityPayload`.
- **Real response shape** (the retrieve fixture,
  [`retrieve-api-response.mock.ts:36`](../src/shared/mocks/retrieve-api-response.mock.ts#L36) —
  truncated payloads for readability):
  ```json
  {
    "components": [
      {
        "componentType": "CalculatedInsight",
        "componentName": "highValueCustomer",
        "dataspaceName": "default",
        "dependsOn": [{ "componentName": "Divvy_TripsDmo", "componentType": "DataModelObject" }],
        "entityPayload": {
          "masterLabel": "testCI",
          "expression": "SELECT COUNT(...) FROM Divvy_TripsDmo__dlm GROUP BY grp__c",
          "definitionType": "CALCULATED_METRIC"
        }
      },
      {
        "componentType": "DataModelObject",
        "componentName": "Divvy_TripsDmo",
        "dataspaceName": "default",
        "dependsOn": [],
        "entityPayload": { "masterLabel": "Divvy Trips", "objectApiName": "Divvy_TripsDmo__dlm" }
      }
    ]
  }
  ```
- **What the CLI does with it:** the retrieve service
  ([`retrieve-service.ts:52`](../src/shared/services/retrieve-service.ts#L52)) writes each component
  to disk under [`data-cloud/<dataspace>/<type-kebab-plural>/<name>.json`](ON_DISK_FORMAT.md), **strips
  `entityPayload` out of the returned result** ([`retrieve-service.ts:93`](../src/shared/services/retrieve-service.ts#L93)),
  and returns the standardized [`RetrieveResult`](../src/shared/types/retrieve.ts#L48). The payload
  lives only on disk, never in `--json` output.

### 3.4 `POST /component/promotion` — submit a deploy

- **Command:** `sf data-cloud deploy --component CalculatedInsight:custom_ci --dataspace default --target-org my-org`
- **Function:** [`createPromotion(conn, request, correlationId?)`](../src/shared/services/devops-api.ts#L337)
- **Query params:** none.
- **Request body:** `{ components: [...] }` — the wrapper is added _here_, not in the assembler. This
  is important enough to have its own section: see [§8](#8-deploy-body-contract--components--).
- **Response type:** [`DeployApiResponse`](../src/shared/types/deploy.ts#L44):
  ```json
  { "status": "SUBMITTED", "jobId": "08PVF000002iQIb" }
  ```
  The deploy is **asynchronous**: the synchronous body is only a submission acknowledgement plus a
  tracking `jobId`. The caller polls `deploy status` (§3.5) until the job reaches a terminal state.
- **CLI output type:** [`DeployResult`](../src/shared/types/deploy.ts#L50) (`{ jobId, status }`).

### 3.5 `GET /component/promotion/{jobId}` — poll deploy status

- **Command:** `sf data-cloud deploy status --job-id 08PVF000002iQIb --target-org my-org`
- **Function:** [`getPromotionStatus(conn, jobId, correlationId?)`](../src/shared/services/devops-api.ts#L387)
- **Path param:** `{jobId}` is URL-encoded defensively (it is a path segment); valid 15/18-char
  Salesforce IDs pass through unchanged.
  ```ts
  // devops-api.ts:401-403
  const resp = await conn.request<DeployStatusApiResponse>(
    getRequest(`${basePath(conn)}/component/promotion/${encodeURIComponent(jobId)}`, correlationId)
  );
  ```
  [`devops-api.ts:402`](../src/shared/services/devops-api.ts#L402)
- **Response type:** [`DeployStatusApiResponse`](../src/shared/types/deploy-status.ts#L51) — overall
  job status **plus a per-component status array**. `status` fields arrive **PascalCase** on the wire
  and are normalized by the service — see [§9](#9-pascalcase--uppercase-enum-normalization).
  ```json
  {
    "jobId": "08PVF000002iQIb",
    "status": "InProgress",
    "components": [
      { "componentName": "custom_ci", "componentType": "CalculatedInsight", "status": "Success" },
      {
        "componentName": "Mock_Profile_Base",
        "componentType": "DataModelObject",
        "status": "Failed",
        "error": "Field CustomerID__c not found"
      }
    ]
  }
  ```
- **CLI output type:** [`DeployStatusResult`](../src/shared/types/deploy-status.ts#L72) (normalized).

---

## 4. Type definitions

Every endpoint has (a) a **raw wire type** — what `conn.request<T>()` deserializes into — and, where
the CLI reshapes it, (b) a **result type** the command returns and `--json` emits. All live under
[`src/shared/types/`](../src/shared/types).

### 4.1 Component types — [`component-type.ts`](../src/shared/types/component-type.ts)

| Type                                                                   | Kind          | Fields                                                          |
| ---------------------------------------------------------------------- | ------------- | --------------------------------------------------------------- |
| [`ComponentTypesResponse`](../src/shared/types/component-type.ts#L25)  | wire          | `supportedComponentTypes: Record<string, string>` (value→label) |
| [`ComponentTypeSummary`](../src/shared/types/component-type.ts#L30)    | flattened row | `componentType: string`, `label: string`                        |
| [`ComponentTypeListResult`](../src/shared/types/component-type.ts#L38) | CLI result    | `componentTypes: ComponentTypeSummary[]`                        |

### 4.2 Component list — [`component.ts`](../src/shared/types/component.ts)

| Type                                                          | Kind       | Fields                           |
| ------------------------------------------------------------- | ---------- | -------------------------------- |
| [`ComponentSummary`](../src/shared/types/component.ts#L25)    | row        | `componentName: string`          |
| [`ComponentsResponse`](../src/shared/types/component.ts#L31)  | wire       | `components: ComponentSummary[]` |
| [`ComponentListResult`](../src/shared/types/component.ts#L36) | CLI result | `components: ComponentSummary[]` |

### 4.3 Retrieve — [`retrieve.ts`](../src/shared/types/retrieve.ts)

| Type                                                            | Kind                 | Fields                                                                                                                          |
| --------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`ComponentDependency`](../src/shared/types/retrieve.ts#L28)    | edge                 | `componentName: string`, `componentType: string`                                                                                |
| [`RawRetrievedComponent`](../src/shared/types/retrieve.ts#L70)  | wire (per component) | `componentType`, `componentName`, `dataspaceName`, `dependsOn: ComponentDependency[]`, `entityPayload: Record<string, unknown>` |
| [`RetrieveApiResponse`](../src/shared/types/retrieve.ts#L84)    | wire (envelope)      | `components: RawRetrievedComponent[]`                                                                                           |
| [`RetrievedComponentInfo`](../src/shared/types/retrieve.ts#L36) | stripped row         | `componentType`, `componentName`, `dataspaceName`, `dependsOn` (**no** `entityPayload`)                                         |
| [`RetrieveResult`](../src/shared/types/retrieve.ts#L48)         | CLI result           | `dataspace`, `targetComponent`, `retrievedComponents: RetrievedComponentInfo[]`, `fileWriteLocation`                            |

> `entityPayload` exists **only** on the raw wire type and on disk. It is stripped before the result
> is returned. This is the mechanism that keeps internal component definitions out of CLI output.

### 4.4 Deploy — [`deploy.ts`](../src/shared/types/deploy.ts)

| Type                                                             | Kind                    | Fields                                                                                                                                                       |
| ---------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`DeploymentLifecycleStatus`](../src/shared/types/deploy.ts#L35) | union                   | `'SUBMITTED' \| 'CREATED' \| 'INPROGRESS' \| 'SUCCESS' \| 'FAILED'`                                                                                          |
| [`DeployRequestComponent`](../src/shared/types/deploy.ts#L65)    | request (per component) | `componentType`, `componentName`, `dataspaceName`, `dependsOn: ComponentDependency[]`, `entityPayload: unknown`                                              |
| [`DeployApiRequest`](../src/shared/types/deploy.ts#L87)          | request                 | `= DeployRequestComponent[]` — a **bare array** (the `{ components: … }` wrapper is added at the HTTP boundary, [§8](#8-deploy-body-contract--components--)) |
| [`DeployApiResponse`](../src/shared/types/deploy.ts#L44)         | wire                    | `status: string`, `jobId: string` (`status` kept as `string` at the boundary so an unexpected backend value never fails type-narrowing)                      |
| [`DeployResult`](../src/shared/types/deploy.ts#L50)              | CLI result              | `jobId: string`, `status: DeploymentLifecycleStatus`                                                                                                         |

> `entityPayload` on `DeployRequestComponent` is typed `unknown` (not `Record<…>`) on purpose: some
> component types (e.g. DataLakeObject definitions, Data Transform) carry a **string** payload, others
> an object. It is passed byte-for-byte and never re-parsed.

### 4.5 Deploy status — [`deploy-status.ts`](../src/shared/types/deploy-status.ts)

| Type                                                                   | Kind                 | Fields                                                                              |
| ---------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| [`ComponentStatus`](../src/shared/types/deploy-status.ts#L33)          | union                | `'SUCCESS' \| 'FAILED' \| 'INPROGRESS'`                                             |
| [`DeployStatusApiComponent`](../src/shared/types/deploy-status.ts#L43) | wire (per component) | `componentName`, `componentType`, `status: string`, `error?: string`                |
| [`DeployStatusApiResponse`](../src/shared/types/deploy-status.ts#L51)  | wire (envelope)      | `jobId: string`, `status: string`, `components: DeployStatusApiComponent[]`         |
| [`DeployStatusComponent`](../src/shared/types/deploy-status.ts#L63)    | normalized row       | `componentName`, `componentType`, `status: ComponentStatus`, `error?: string`       |
| [`DeployStatusResult`](../src/shared/types/deploy-status.ts#L72)       | CLI result           | `jobId`, `status: DeploymentLifecycleStatus`, `components: DeployStatusComponent[]` |

---

## 5. Authentication

The CLI never manages credentials directly — it relies entirely on `@salesforce/core`.

1. **The org flag.** Each network command declares a required org flag (`Flags.requiredOrg`):
   - Read commands + retrieve use **`--src-org`** (with alias `--target-org`):
     [`retrieve.ts` flags](../src/commands/data-cloud/retrieve.ts) — `'src-org': Flags.requiredOrg({ aliases: ['target-org'] })`.
   - Deploy + deploy status use **`--target-org`**:
     [`deploy/index.ts` flags](../src/commands/data-cloud/deploy/index.ts),
     [`deploy/status.ts` flags](../src/commands/data-cloud/deploy/status.ts).
2. **Resolving a connection.** The command turns the flag into an authenticated `Connection`, honoring
   the optional `--api-version` override:
   ```ts
   // src/commands/data-cloud/retrieve.ts
   const conn = flags['src-org'].getConnection(flags['api-version']);
   ```
   (Deploy uses `flags['target-org'].getConnection(...)`.)
3. **Session management is handed off.** `@salesforce/core` owns everything about the session — token
   storage, refresh, the instance URL. The service layer receives a live `Connection` and does nothing
   but call `conn.request(...)`. There is **no** auth code, no header minting, no token handling in
   this plugin.
4. **`--api-version`.** When supplied, it flows into the connection and thus into
   [`conn.getApiVersion()`](../src/shared/services/devops-api.ts#L45), which is exactly the value the
   base path uses ([§2](#2-base-path-construction)). This is the sanctioned way to pin a version — never
   by editing `basePath`.

To authenticate an org for local use: `sf org login web --alias my-org`, then pass
`--src-org my-org` / `--target-org my-org`.

---

## 6. Error mapping

The HTTP boundary never lets a raw jsforce/network error escape. Every `conn.request` call is wrapped
in `try/catch` and the caught error is passed through
[`toSfError(err, op)`](../src/shared/services/devops-api.ts#L89), which produces a **structured,
actionable `SfError`** (code + message + remediation actions). The four codes:

| Trigger (error code / message match)                              | `SfError.code`              | Meaning                                                           |
| ----------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `DomainNotFoundError`, or `/ENOTFOUND\|ECONNREFUSED\|ETIMEDOUT/i` | `DataCloudApiNetworkError`  | Could not reach the org.                                          |
| `INVALID_SESSION_ID`, `ERROR_HTTP_401`                            | `DataCloudApiAuthError`     | Session invalid/expired → re-authenticate.                        |
| `NOT_FOUND`, `ERROR_HTTP_404`                                     | `DataCloudApiNotFoundError` | Endpoint/component/dataspace not found or Data Cloud not enabled. |
| anything else                                                     | `DataCloudApiError`         | Fallback, message preserved.                                      |

```ts
// devops-api.ts:96-104 (the network branch)
if (code === 'DomainNotFoundError' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
  return new SfError(
    `Could not reach the org to ${op}. ${message}`,
    'DataCloudApiNetworkError',
    ['Check your network connection and that the org instance URL is reachable.'],
    undefined,
    cause
  );
}
```

[`devops-api.ts:96`](../src/shared/services/devops-api.ts#L96)

The `op` argument is a human phrase each caller passes (`'list component types'`,
`` `retrieve snapshot for ${type}:${name}` ``, `'deploy components'`, …) so the message names the
operation that failed. **Full detail — including the deploy-status-specific `errorCode` derivation
(`ComponentValidationError` vs `DeployJobFailed`) — is in [`docs/ERROR_HANDLING.md`](ERROR_HANDLING.md).**

---

## 7. Correlation header

The CLI mints one **`correlationId`** (a `randomUUID()`) per top-level operation in each service
(retrieve/deploy/status) and emits it on **every telemetry event** for that operation, so all events
for one command invocation join by a single id. That id is _also_ threaded down into the HTTP boundary
functions as the `correlationId` argument.

**The request-header propagation is intentionally gated OFF.** The plan is to _also_ send the id as a
request header so the backend's Connect API logs join to the CLI event by the same id — but the exact
header name the backend reads could not be determined from code, so it must be confirmed with the
backend owner before shipping.

```ts
// devops-api.ts:57-58
export const CORRELATION_ID_HEADER = 'x-correlation-id';
const SEND_CORRELATION_HEADER: boolean = false;
```

[`devops-api.ts:57`](../src/shared/services/devops-api.ts#L57)

- **`x-correlation-id` is a PLACEHOLDER.** Do not treat it as the confirmed header name.
- While the gate is `false`, requests are built **byte-for-byte as they are today**: GETs are a bare
  URL **string**; the POST sends only `Content-Type: application/json`. No unrecognized header is ever
  sent.
- Two helpers implement the gate so both shapes are unit-testable
  ([`correlationHeaders`](../src/shared/services/devops-api.ts#L65),
  [`getRequest`](../src/shared/services/devops-api.ts#L76)):
  ```ts
  // devops-api.ts:76-81 — GET request builder
  export const getRequest = (url, correlationId, enabled = SEND_CORRELATION_HEADER) =>
    enabled ? { method: 'GET', url, headers: correlationHeaders(correlationId, enabled) } : url;
  ```
- **The type is annotated `: boolean` (not the literal `false`)** on purpose — it keeps the gate a
  real runtime check so the compiler does not dead-code-eliminate the enabled branch, and so tests can
  exercise the enabled shape by passing `enabled = true`.

**To turn it on later (the entire remaining step):** confirm the real header name with the backend,
set `CORRELATION_ID_HEADER` to it, and flip `SEND_CORRELATION_HEADER` to `true`. See
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) for the CLI → Connect API → Layer 3 correlation story.

---

## 8. Deploy body contract (`{ components: [...] }`)

The deploy request is assembled in two stages, and **the wrapper object is added at the HTTP boundary,
not by the assembler.** Getting this right is load-bearing — the backend handler iterates
`input.getComponents()`, so a bare array on the wire would not deserialize.

**Stage 1 — assemble a bare array** ([`assembleDeployRequest`](../src/shared/services/deploy-service.ts#L68)).
The deploy service reads the named component from disk, walks its transitive `dependsOn`, and maps each
on-disk `ComponentFile` to a `DeployRequestComponent`, carrying `entityPayload` through **verbatim**:

```ts
// deploy-service.ts:68-76
export function assembleDeployRequest(components: ComponentFile[]): DeployApiRequest {
  return components.map((file) => ({
    componentType: file.componentType,
    componentName: file.componentName,
    dataspaceName: file.dataspaceName,
    dependsOn: file.dependsOn,
    entityPayload: file.entityPayload,
  }));
}
```

[`deploy-service.ts:68`](../src/shared/services/deploy-service.ts#L68) — the return type is
`DeployApiRequest = DeployRequestComponent[]`, i.e. a bare array with **no wrapper**.

**Stage 2 — wrap and POST** ([`createPromotion`](../src/shared/services/devops-api.ts#L337)). The HTTP
boundary wraps that array in a top-level `components` key when it stringifies the body:

```ts
// devops-api.ts:353-359
const resp = await conn.request<DeployApiResponse>({
  method: 'POST',
  url: `${basePath(conn)}/component/promotion`,
  body: JSON.stringify({ components: request }), // ← the { components: [...] } wrapper
  headers: { 'Content-Type': 'application/json', ...correlationHeaders(correlationId) },
});
```

[`devops-api.ts:356`](../src/shared/services/devops-api.ts#L356)

The docstring above the function records that this is **confirmed with the backend** and mirrors
`CdpDevOpsComponentPayloadInputRepresentation` (`getEntityPayload` / `getDataspaceName`), which the
handler iterates over `input.getComponents()`
([`devops-api.ts:331`](../src/shared/services/devops-api.ts#L331)).

**Assembled body on the wire** (for `deploy --component CalculatedInsight:custom_ci --dataspace default`,
sending `custom_ci` + its DMO dependency — payloads truncated):

```json
{
  "components": [
    {
      "componentType": "CalculatedInsight",
      "componentName": "custom_ci",
      "dataspaceName": "default",
      "dependsOn": [{ "componentName": "Mock_Profile_Base", "componentType": "DataModelObject" }],
      "entityPayload": { "masterLabel": "custom_ci", "definitionType": "CALCULATED_METRIC", "...": "..." }
    },
    {
      "componentType": "DataModelObject",
      "componentName": "Mock_Profile_Base",
      "dataspaceName": "default",
      "dependsOn": [],
      "entityPayload": { "...": "..." }
    }
  ]
}
```

Key invariants:

- **No top-level `dataSpaceName`.** Dataspace is carried **per component** in `dataspaceName`.
- Each element is the exact on-disk snapshot JSON. `entityPayload` is passed through byte-for-byte and
  **never re-parsed** — a string stays a string, an object stays an object.
- The client sends the components; the **server** validates and computes the topological deploy order
  (that ordering is Layer 3, not the CLI).

> **Discrepancy to note.** The `DeployApiRequest` type doc and `assembleDeployRequest` describe "a bare
> ARRAY … no wrapper object", which is true **of the assembler's output**. The actual HTTP body **is**
> wrapped (`createPromotion`). Both are correct at their respective layers, but read together they can
> mislead: the wrapper is added at the boundary. The `createPromotion` docstring is the authoritative,
> backend-confirmed description of what goes on the wire.

---

## 9. PascalCase → UPPERCASE enum normalization

The backend returns deploy-status enums in **PascalCase** (`CdpDevOpsPromotionStatusEnum` /
`CdpDevOpsComponentStatusEnum`: `Success`, `Failed`, `InProgress`, `Created`, `Pending`). The CLI's own
vocabulary is **UPPERCASE** ([`DeploymentLifecycleStatus`](../src/shared/types/deploy.ts#L35) /
[`ComponentStatus`](../src/shared/types/deploy-status.ts#L33)). The normalization happens in exactly
one place — the deploy-status service seam — so the command and the HTTP boundary stay agnostic of the
wire casing.

**Overall job status** ([`toLifecycleStatus`](../src/shared/services/deploy-status-service.ts#L48)):

```ts
// deploy-status-service.ts:48-60
export function toLifecycleStatus(raw: string): DeploymentLifecycleStatus {
  switch (raw) {
    case 'Success':
      return 'SUCCESS';
    case 'Failed':
      return 'FAILED';
    case 'Created':
      return 'CREATED';
    case 'InProgress':
    default:
      return 'INPROGRESS';
  }
}
```

[`deploy-status-service.ts:48`](../src/shared/services/deploy-status-service.ts#L48)

**Per-component status** ([`toComponentStatus`](../src/shared/services/deploy-status-service.ts#L67)) is
the same idea, additionally folding `Pending` → `INPROGRESS`.

**Before → after:**

| Wire (PascalCase)    | Normalized (UPPERCASE) | Applies to      |
| -------------------- | ---------------------- | --------------- |
| `Success`            | `SUCCESS`              | job + component |
| `Failed`             | `FAILED`               | job + component |
| `Created`            | `CREATED`              | job only        |
| `InProgress`         | `INPROGRESS`           | job + component |
| `Pending`            | `INPROGRESS`           | component only  |
| _(anything unknown)_ | `INPROGRESS`           | job + component |

**Why fold unknowns to `INPROGRESS`?** `INPROGRESS` is non-terminal. An unexpected/unrecognized backend
value therefore never causes a poll to report a **false terminal state** — the caller keeps polling
rather than prematurely declaring SUCCESS or FAILED.

Worked example — wire `"InProgress"` with one failed component:

```jsonc
// Wire (GET /component/promotion/{jobId})
{ "jobId": "08P…", "status": "InProgress",
  "components": [ { "componentName": "custom_ci", "componentType": "CalculatedInsight", "status": "Success" },
                  { "componentName": "Mock_Profile_Base", "componentType": "DataModelObject", "status": "Failed", "error": "…" } ] }

// After normalization (DeployStatusResult, what --json emits)
{ "jobId": "08P…", "status": "INPROGRESS",
  "components": [ { "componentName": "custom_ci", "componentType": "CalculatedInsight", "status": "SUCCESS" },
                  { "componentName": "Mock_Profile_Base", "componentType": "DataModelObject", "status": "FAILED", "error": "…" } ] }
```

> **Two distinct mappings — do not conflate them.**
>
> - **Contract normalization** (this section, in the service): `Success` → **`SUCCESS`**. This is the
>   value in `DeployStatusResult` and in `--json`.
> - **Display relabel** (in the command, [`deploy/status.ts`](../src/commands/data-cloud/deploy/status.ts)):
>   the _human table_ renders `SUCCESS` as **`SUCCEEDED`** (`c.status === 'SUCCESS' ? 'SUCCEEDED' : …`).
>   This is presentation only — the contract value returned to programs stays `SUCCESS`.

---

## Appendix: contract-vs-docs discrepancies

Where the **code** and `CLAUDE.md` / `PROJECT_KNOWLEDGE.md` disagree, **the code is authoritative** for
what actually crosses the wire. Flagged here for the maintainer:

| #   | Topic                             | `CLAUDE.md` / older docs say                                                                                      | Code actually does                                                                                                                                                                                                                                                                                                                                              | Where                                                                                                                                                                                                                           |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Endpoint paths**                | `component-object-api-names`, `retrieve`, `deploy`, `deploy/{jobId}/status`                                       | `component/catalog`, `component/snapshot`, `component/promotion`, `component/promotion/{jobId}`. Only `component-types` matches.                                                                                                                                                                                                                                | [`devops-api.ts:222`](../src/shared/services/devops-api.ts#L222), [`:300`](../src/shared/services/devops-api.ts#L300), [`:355`](../src/shared/services/devops-api.ts#L355), [`:402`](../src/shared/services/devops-api.ts#L402) |
| 2   | **Deploy body shape**             | Type docs describe a "bare ARRAY … no wrapper object"                                                             | The actual POST body **is** wrapped: `{ components: [...] }`, added in `createPromotion` (backend-confirmed). The bare array is only the _assembler's_ output.                                                                                                                                                                                                  | [`devops-api.ts:356`](../src/shared/services/devops-api.ts#L356) vs [`deploy.ts:81`](../src/shared/types/deploy.ts#L81)                                                                                                         |
| 3   | **Deploy response `jobId`**       | `deploy-service.ts` JSDoc (line 81) says "The live backend returns only `{ status: 'SUBMITTED' }` (no jobId yet)" | The code reads and returns `api.jobId`; the inline comment at [`deploy-service.ts:135`](../src/shared/services/deploy-service.ts#L135) says "The backend always returns a tracking jobId." The line-81 JSDoc is **stale**.                                                                                                                                      | [`deploy-service.ts:137`](../src/shared/services/deploy-service.ts#L137)                                                                                                                                                        |
| 4   | **`Submitted` status casing**     | Lifecycle union includes `SUBMITTED`; deploy returns it                                                           | `toLifecycleStatus` has **no** `'Submitted'` case, so a _status-poll_ returning wire `"Submitted"` would fold to `INPROGRESS`. (The _submit_ response's `SUBMITTED` comes straight from `DeployApiResponse.status`, un-normalized, so `deploy` still reports `SUBMITTED` correctly.) Worth confirming the poll's terminal-vs-submitted casing with the backend. | [`deploy-status-service.ts:48`](../src/shared/services/deploy-status-service.ts#L48)                                                                                                                                            |
| 5   | **`deploy status` display value** | —                                                                                                                 | Command relabels `SUCCESS` → `SUCCEEDED` for the human table only; `--json` keeps `SUCCESS`. Documented in [§9](#9-pascalcase--uppercase-enum-normalization) so consumers know which value to assert against.                                                                                                                                                   | [`deploy/status.ts`](../src/commands/data-cloud/deploy/status.ts)                                                                                                                                                               |
