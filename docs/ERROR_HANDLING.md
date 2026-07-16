# Error Handling

How `@salesforce/plugin-datacloud-devops` turns low-level failures into **structured, actionable**
errors, where each error class is defined and thrown, how errors propagate from the HTTP boundary out
to the user's terminal, and what leaks into telemetry on failure.

> **Scope.** This project owns the **CLI (Layer 1)** and the **Connect API contracts (Layer 2 — the
> representation classes)**. It does **not** own the Connect API _implementation_, the spidering, or
> the **DataKit Orchestration Layer (Layer 3)**. Consequently this document describes only how the CLI
> _reacts to_ and _reshapes_ the errors the backend hands it. It never describes how the backend
> produces them, and — by hard rule — it never surfaces backend/DataKit internals (see
> [§5](#5-the-never-surface-datakit-internals-rule)).
>
> **Code is the source of truth.** Every claim below is anchored to a file and line range. Where the
> code diverges from [CLAUDE.md](../CLAUDE.md) or `PROJECT_KNOWLEDGE.md`, the divergence is flagged
> explicitly rather than smoothed over. See [Conflicts with the docs](#conflicts-with-claudemd--project_knowledgemd).

**Related docs:** [TELEMETRY.md](./TELEMETRY.md) (failure-event fields, `gackId`, App Insights) ·
[ARCHITECTURE.md](./ARCHITECTURE.md) (the thin-client / service / HTTP-boundary layering).

---

## Table of contents

1. [The `toSfError()` mapping function](#1-the-tosferror-mapping-function)
2. [Error classification table](#2-error-classification-table)
3. [Anatomy of an `SfError`](#3-anatomy-of-an-sferror)
4. [Command-layer error classes](#4-command-layer-error-classes)
5. [The "never surface DataKit internals" rule](#5-the-never-surface-datakit-internals-rule)
6. [How errors propagate (end to end)](#6-how-errors-propagate-end-to-end)
7. [Error telemetry](#7-error-telemetry)

---

## 1. The `toSfError()` mapping function

Every network round-trip in this plugin flows through **one** HTTP boundary,
[`src/shared/services/devops-api.ts`](../src/shared/services/devops-api.ts). That file is the only
place `Connection.request` is called, and it is the only place low-level jsforce/connection errors are
translated into structured `SfError`s. Doing the translation here — and nowhere else — is what keeps
the command layer and the orchestration services "thin": they never have to reason about raw gacks or
HTTP status codes.

The translator is the private function `toSfError(err, op)`,
[devops-api.ts:89-127](../src/shared/services/devops-api.ts#L89-L127):

```ts
function toSfError(err: unknown, op: string): SfError {
  const e = err as { name?: string; errorCode?: string; message?: string };
  const code = e?.errorCode ?? e?.name ?? '';
  const message = e?.message ?? String(err);
  // SfError's `cause` must be an Error (it throws otherwise), so only forward real Errors.
  const cause = err instanceof Error ? err : undefined;

  if (code === 'DomainNotFoundError' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return new SfError(
      `Could not reach the org to ${op}. ${message}`,
      'DataCloudApiNetworkError',
      ['Check your network connection and that the org instance URL is reachable.'],
      undefined,
      cause
    );
  }
  if (code === 'INVALID_SESSION_ID' || code === 'ERROR_HTTP_401') {
    return new SfError(
      `Your session is invalid or expired while trying to ${op}.`,
      'DataCloudApiAuthError',
      ['Re-authenticate with `sf org login web` and try again.'],
      undefined,
      cause
    );
  }
  if (code === 'NOT_FOUND' || code === 'ERROR_HTTP_404') {
    return new SfError(
      `The Data Cloud DevOps API returned 404 while trying to ${op}.`,
      'DataCloudApiNotFoundError',
      [
        'Confirm the org has Data Cloud (Data 360) enabled and the DevOps API is available.',
        'Verify the component type, name, and dataspace are correct.',
      ],
      undefined,
      cause
    );
  }
  return new SfError(`Failed to ${op}: ${message}`, 'DataCloudApiError', undefined, undefined, cause);
}
```

### Walking each branch

**Preamble (lines 90-94) — normalize the shape of "err".**
The caught value is `unknown`. jsforce/`@salesforce/core` errors come in inconsistent shapes: some
carry an `errorCode` (e.g. `'INVALID_SESSION_ID'`), some only a `name` (e.g. `'DomainNotFoundError'`),
and a raw `Error` carries neither. The function coalesces those into a single `code`:

- `code = e?.errorCode ?? e?.name ?? ''` — prefer the Salesforce `errorCode`, fall back to the JS
  error `name`, and finally to `''` so the string comparisons below are always safe.
- `message = e?.message ?? String(err)` — a human string for both the branch regex test and the final
  mapped message.
- `cause = err instanceof Error ? err : undefined` — this is a deliberate guard. `SfError`'s
  constructor **throws** if you hand it a `cause` that is not an `Error`, so a plain object like
  `{ errorCode, message }` (which is exactly what jsforce often rejects with, and what several tests
  use) must be dropped rather than forwarded. Only a real `Error` becomes the `cause`.

**Branch 1 — Network (lines 96-104).** Fires when `code === 'DomainNotFoundError'` **or** the message
matches `/ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i`. This is the one branch that also inspects the message
text, because a raw connection failure (`new Error('connect ECONNREFUSED …')`) arrives with no useful
`errorCode`/`name`. Produces code `DataCloudApiNetworkError`, and — uniquely — appends the original
`message` to the user-facing text (`… to ${op}. ${message}`), since for a network failure the OS-level
detail ("getaddrinfo ENOTFOUND", "connect ECONNREFUSED …") is genuinely useful and contains no
backend/customer data.

**Branch 2 — Auth (lines 105-113).** Fires on `code === 'INVALID_SESSION_ID'` or `'ERROR_HTTP_401'`.
Produces `DataCloudApiAuthError` with a single remediation: re-authenticate with `sf org login web`.
The raw message is **not** appended here (a session error's raw text carries nothing actionable).

**Branch 3 — NotFound (lines 114-125).** Fires on `code === 'NOT_FOUND'` or `'ERROR_HTTP_404'`.
Produces `DataCloudApiNotFoundError` with **two** remediation actions: confirm Data Cloud (Data 360) is
enabled and the DevOps API is available, and verify the component type/name/dataspace. A 404 on these
endpoints is genuinely ambiguous — either the feature isn't provisioned or the caller mistyped a
component — so both leads are offered.

**Fallback — Generic (line 126).** Anything unrecognized becomes `DataCloudApiError` with message
`Failed to ${op}: ${message}` and **no** `actions[]` (the `undefined` third argument). This is the
catch-all; it still preserves the operation phrase and the original message so the failure is
diagnosable, but it makes no promises about remediation because the cause is unknown.

### The `op` phrase per call site

`op` is a short human phrase describing what was being attempted; it is interpolated into every mapped
message. Each API function passes its own:

| Function             | Endpoint (as coded)                   | `op` argument                                                   | Source                                                         |
| -------------------- | ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| `getComponentTypes`  | `GET .../component-types`             | `'list component types'`                                        | [devops-api.ts:166](../src/shared/services/devops-api.ts#L166) |
| `getComponents`      | `GET .../component/catalog`           | `` `list components of type "${componentType}"` ``              | [devops-api.ts:242](../src/shared/services/devops-api.ts#L242) |
| `getSnapshot`        | `GET .../component/snapshot`          | `` `retrieve snapshot for ${componentType}:${componentName}` `` | [devops-api.ts:311](../src/shared/services/devops-api.ts#L311) |
| `createPromotion`    | `POST .../component/promotion`        | `'deploy components'`                                           | [devops-api.ts:367](../src/shared/services/devops-api.ts#L367) |
| `getPromotionStatus` | `GET .../component/promotion/{jobId}` | `` `check deploy status for job "${jobId}"` ``                  | [devops-api.ts:412](../src/shared/services/devops-api.ts#L412) |

> **Note on `SfError.name` vs `code`.** The second constructor argument is the machine-readable
> **code**. `@salesforce/core`'s `SfError` also exposes it as `.name`, which is why the unit tests
> assert `(err as SfError).name === 'DataCloudApiAuthError'`
> ([devops-api.test.ts:291](../test/shared/services/devops-api.test.ts#L291)). `code` and `name` are
> the same string here.

---

## 2. Error classification table

Four classes come out of `toSfError`. The "Trigger" column lists the exact conditions from the branch
predicates above; `${op}` is the per-call phrase from the table in [§1](#the-op-phrase-per-call-site).

| Class                  | Trigger (matched on `errorCode`/`name`/`message`)                                               | Code (`SfError.code`)       | Message template                                                | `actions[]`                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network**            | `code === 'DomainNotFoundError'` **or** message matches `/ENOTFOUND\|ECONNREFUSED\|ETIMEDOUT/i` | `DataCloudApiNetworkError`  | `Could not reach the org to ${op}. ${message}`                  | `['Check your network connection and that the org instance URL is reachable.']`                                                                         |
| **Auth**               | `code === 'INVALID_SESSION_ID'` **or** `code === 'ERROR_HTTP_401'`                              | `DataCloudApiAuthError`     | `Your session is invalid or expired while trying to ${op}.`     | `` ['Re-authenticate with `sf org login web` and try again.'] ``                                                                                        |
| **NotFound**           | `code === 'NOT_FOUND'` **or** `code === 'ERROR_HTTP_404'`                                       | `DataCloudApiNotFoundError` | `The Data Cloud DevOps API returned 404 while trying to ${op}.` | `['Confirm the org has Data Cloud (Data 360) enabled and the DevOps API is available.', 'Verify the component type, name, and dataspace are correct.']` |
| **Generic (fallback)** | any other value                                                                                 | `DataCloudApiError`         | `Failed to ${op}: ${message}`                                   | _(none — `undefined`)_                                                                                                                                  |

These four classes are exactly what the mapping tests in
[devops-api.test.ts:283-337](../test/shared/services/devops-api.test.ts#L283-L337) pin down (one test
per branch, plus the generic fallback).

---

## 3. Anatomy of an `SfError`

Every error surfaced by the API boundary is a `SfError` from `@salesforce/core`, constructed with the
argument order `(message, code, actions, exitCode, cause)`:

| Field           | Argument                      | Purpose                                                         | Audience                                |
| --------------- | ----------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| **`message`**   | 1st                           | Human-readable description of what failed.                      | The user, in the terminal.              |
| **`code`**      | 2nd (also exposed as `.name`) | Stable machine-parseable identifier for the failure class.      | Scripts, `--json` consumers, telemetry. |
| **`actions[]`** | 3rd                           | Ordered remediation steps rendered under the error.             | The user.                               |
| **`exitCode`**  | 4th (`undefined` here)        | Process exit code; left to the default.                         | Shells / CI.                            |
| **`cause`**     | 5th                           | The original underlying `Error` (only when it _is_ an `Error`). | Debuggers; not shown by default.        |

### A fully constructed example (from the code)

The **Auth** branch, [devops-api.ts:106-112](../src/shared/services/devops-api.ts#L106-L112), for a
`getComponentTypes` call (`op = 'list component types'`):

```ts
new SfError(
  'Your session is invalid or expired while trying to list component types.', // message
  'DataCloudApiAuthError', // code (== .name)
  ['Re-authenticate with `sf org login web` and try again.'], // actions[]
  undefined, // exitCode (default)
  cause // original Error, or undefined
);
```

### Worked failing-request example

The unit test at
[devops-api.test.ts:284-294](../test/shared/services/devops-api.test.ts#L284-L294) drives a real
failing request. The stubbed connection rejects with:

```ts
{ errorCode: 'INVALID_SESSION_ID', message: 'Session expired' }
```

Because that reject value is a **plain object, not an `Error`**, the `cause` guard on
[devops-api.ts:94](../src/shared/services/devops-api.ts#L94) drops it (`cause = undefined`). The
Auth branch matches on `errorCode === 'INVALID_SESSION_ID'`, and `toSfError` returns:

```jsonc
{
  "name": "DataCloudApiAuthError", // == code
  "code": "DataCloudApiAuthError",
  "message": "Your session is invalid or expired while trying to list component types.",
  "actions": ["Re-authenticate with `sf org login web` and try again."],
  "cause": undefined // the plain reject object was NOT forwarded
}
```

Note that the raw text `'Session expired'` **does not appear** anywhere in the mapped error — the Auth
branch does not append `${message}`. The test asserts exactly this outcome: the thrown value is an
`SfError`, `.name` is `DataCloudApiAuthError`, and `.actions` matches `/org login/i`.

---

## 4. Command-layer error classes

`toSfError` handles _network / backend_ failures. A second family of errors is raised **before** (or
instead of) any network call — during flag parsing, local file reads, and dependency-graph walking.
These are the "local" failures: bad input, or a `data-cloud/` tree that isn't in the shape a prior
`retrieve` would have produced. They are all plain `SfError`s distinguished by their `code`
(2nd constructor argument); there are no bespoke subclasses.

| Code                        | Defined / thrown at                                                                                                                                                                | Trigger                                                                                                                                                                                                                                              | Message                                                                                                                                     | Remediation                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `InvalidComponentFlagError` | [deploy-service.ts:50-53](../src/shared/services/deploy-service.ts#L50-L53) (in `parseComponentFlag`)                                                                              | `--component` value is not `TYPE:NAME` (no interior colon: colon at index ≤ 0 or as the last char).                                                                                                                                                  | `Invalid --component format "${component}". Expected TYPE:NAME (e.g., CalculatedInsight:highValueCustomer).`                                | Re-run with a `TYPE:NAME` value. Message embeds the example.                |
| `InvalidComponentTypeError` | [file-reader.ts:57](../src/shared/services/file-reader.ts#L57) (in `pathForComponent`, via `folderForComponentType`)                                                               | Component type is empty/blank when computing an on-disk path.                                                                                                                                                                                        | _(raised by `folderForComponentType` in [constants/component-paths.ts](../src/shared/constants/component-paths.ts))_                        | Provide a non-empty component type.                                         |
| `ComponentNotFoundError`    | [file-reader.ts:128-132](../src/shared/services/file-reader.ts#L128-L132) (in `readComponentFile`)                                                                                 | No file at any candidate path (root path, then dataspace path); reports the canonical writer location.                                                                                                                                               | `Component "${componentType}:${componentName}" not found at expected path: ${canonicalPath}. Run "sf data-cloud retrieve" first.`           | Run `sf data-cloud retrieve` to fetch the component.                        |
| `InvalidComponentFileError` | [file-reader.ts:146](../src/shared/services/file-reader.ts#L146) (bad JSON) and [file-reader.ts:152-155](../src/shared/services/file-reader.ts#L152-L155) (missing required field) | File exists but is not valid JSON, **or** is missing one of the required fields `componentType`, `componentName`, `dataspaceName`, `dependsOn`, `entityPayload` (`REQUIRED_FIELDS`, [file-reader.ts:40](../src/shared/services/file-reader.ts#L40)). | `Component file at "${filePath}" contains invalid JSON.` / `Component file at "${filePath}" is invalid: missing required field "${field}".` | Re-retrieve or repair the file; the message names the exact path and field. |
| `DependencyNotFoundError`   | [file-reader.ts:205-210](../src/shared/services/file-reader.ts#L205-L210) (in `collectTransitiveDependencies`)                                                                     | A component's `dependsOn` entry has no file on disk (a `ComponentNotFoundError` for a _dependency_ is re-labeled here to name both the missing dep and its referrer).                                                                                | `Dependency "${dep…}" (referenced by "${component…}") not found on disk. Run "sf data-cloud retrieve" to fetch the full dependency graph.`  | Run `sf data-cloud retrieve` to fetch the full graph.                       |

**Why the re-labeling on line 204-211 matters.** `collectTransitiveDependencies` calls
`readComponentFile` for each dependency. If that throws `ComponentNotFoundError`, the walker catches it
([file-reader.ts:203-212](../src/shared/services/file-reader.ts#L203-L212)) and re-throws a
`DependencyNotFoundError` that names **both** the missing dependency and the component that referenced
it — a strictly more actionable message than "component X not found" for something the user never asked
for directly. Any other error (e.g. an `EACCES` permission error, which `readComponentFile` deliberately
re-throws unchanged at [file-reader.ts:119](../src/shared/services/file-reader.ts#L119)) propagates
untouched.

> These codes satisfy the hard rule that "errors must be structured and actionable (code + message +
> failing component)": each one carries a stable `code`, names the offending component (or file/field),
> and points at the fix.

---

## 5. The "never surface DataKit internals" rule

**Hard rule ([CLAUDE.md](../CLAUDE.md) rule 4):** the CLI must never surface DataKit internals — no
DataKit names, no template names, no `&quot;`-encoded XML, and no raw gacks — in output or in files
written to disk. This is an **error-handling constraint**, not just an output-formatting one, because
the most likely place internals would leak is inside a raw backend error message.

How the design enforces it:

- **The mapping layer redacts by construction.** For the Auth and NotFound branches, `toSfError`
  writes a fixed, human-authored message and **does not** append the raw `${message}`
  ([devops-api.ts:107](../src/shared/services/devops-api.ts#L107),
  [devops-api.ts:116](../src/shared/services/devops-api.ts#L116)). The raw backend text — the most
  likely carrier of DataKit/template internals — never reaches the terminal for those classes. Only the
  Network and Generic branches include `${message}`, and those messages are OS/transport-level
  (`ENOTFOUND`, `connect ECONNREFUSED …`) rather than DataKit payloads.
- **The comment at the top of the boundary states the intent** — callers "stay thin and never surface
  raw gacks" ([devops-api.ts:36-42](../src/shared/services/devops-api.ts#L36-L42)).
- **Gack-id extraction ships disabled.** `GACK_EXTRACTION_ENABLED = false`
  ([telemetry.ts:94](../src/shared/services/telemetry.ts#L94)) so `extractGackId` always returns
  `undefined` ([telemetry.ts:98-101](../src/shared/services/telemetry.ts#L98-L101)). A gack id is a
  server-side artifact; it stays out of telemetry until the marker/format is confirmed with the backend
  (see [§7](#7-error-telemetry) and [TELEMETRY.md](./TELEMETRY.md)).
- **Test enforcement.** The telemetry failure test asserts the raw reject text never leaks:
  `expect(JSON.stringify(e)).to.not.match(/Session expired/)`
  ([devops-api.test.ts:434](../test/shared/services/devops-api.test.ts#L434)), and no `gackId` key is
  present ([devops-api.test.ts:435](../test/shared/services/devops-api.test.ts#L435)).

> **Honest scope note.** This layer redacts what it can _see_ and controls what it _emits_. It cannot
> guarantee the backend never places an internal detail in, say, a Network-branch OS message — that
> would require controlling the Connect API implementation (Layer 3), which this project does not own.
> The mapping structure is designed to minimize the surface; the backend contract owns the rest.

---

## 6. How errors propagate (end to end)

The propagation contract is three-tier:

1. **HTTP boundary (`devops-api.ts`)** — catches the raw failure, calls `toSfError`, emits telemetry
   (where applicable — see below), and `throw`s the **mapped `SfError`**. It never throws the raw
   error. See e.g. [devops-api.ts:165-188](../src/shared/services/devops-api.ts#L165-L188).
2. **Orchestration service (`retrieve-service.ts` / `deploy-service.ts`)** — catches, emits its own
   orchestration-level failure telemetry + local diagnostics, then **re-throws the original error
   object unchanged** (`throw err;`,
   [retrieve-service.ts:149](../src/shared/services/retrieve-service.ts#L149),
   [deploy-service.ts:188](../src/shared/services/deploy-service.ts#L188)). It does **not** re-wrap:
   whatever `SfError` bubbled up (mapped API error, or a local `file-reader` error) stays intact.
3. **Command (`SfCommand` subclass)** — does **not** try/catch; it `await`s and lets any error escape.
   The tier-2 orchestration-service re-throw step applies only to `retrieve`/`deploy`, which go through
   an orchestration service (e.g. [retrieve.ts:53-72](../src/commands/data-cloud/retrieve.ts#L53-L72)
   awaits `retrieveComponents`). `component list` has **no** orchestration service — there is no
   `component-list-service` in `src/shared/services/` — so it is a **two-tier** path (command → HTTP
   boundary): [component/list.ts:57-80](../src/commands/data-cloud/component/list.ts#L57-L80) awaits the
   HTTP boundary `getComponents` in `devops-api.ts` directly, and the mapped `SfError` is thrown
   straight from the boundary to `SfCommand`, skipping the tier-2 re-throw. Either way, `SfCommand`
   (from `@salesforce/sf-plugins-core`) is the base error renderer: it prints `message` + `actions[]`
   in human mode, and in `--json` mode wraps the error in the standard `sf` envelope
   (`{ status, name, message, exitCode, ... }`). The plugin adds no custom rendering.

```
Connection.request rejects (raw jsforce/network error)
        │
        ▼
devops-api.ts  ──► toSfError(err, op)  ──► SfError(code, message, actions[], cause)
        │                                        │  emits DATACLOUD_DEVOPS_API_REQUEST failure
        │                                        │  (getComponentTypes / getComponents only)
        └── throw mapped ────────────────────────┘
        ▼
retrieve-service.ts / deploy-service.ts
        │  catch → emit RETRIEVE/DEPLOY failure telemetry + diag.error → throw err  (ORIGINAL, unchanged)
        ▼
command (SfCommand)  ── no try/catch; error escapes ──►
        ▼
SfCommand base renderer
        ├── human mode:  "Error (DataCloudApiAuthError): <message>"  + "Try this:" <actions>
        └── --json mode: { "status": 1, "name": "DataCloudApiAuthError", "message": ..., ... }
```

### One path traced end to end: `sf data-cloud retrieve` with an expired session

1. **Command.** `run()` resolves the connection and calls
   `retrieveComponents(conn, flags.component, flags.dataspace)`
   ([retrieve.ts:59](../src/commands/data-cloud/retrieve.ts#L59)). No try/catch.
2. **Service.** `retrieveComponents` parses the flag, then calls
   `getSnapshot(conn, type, name, dataspace, correlationId)`
   ([retrieve-service.ts:84](../src/shared/services/retrieve-service.ts#L84)) inside a `try`.
3. **Boundary.** `getSnapshot`'s `conn.request` rejects with `INVALID_SESSION_ID`. The catch
   ([devops-api.ts:310-322](../src/shared/services/devops-api.ts#L310-L322)) calls
   `toSfError(err, 'retrieve snapshot for CalculatedInsight:highValueCustomer')`, logs a local
   `diag.error`, and `throw mapped;` — a `DataCloudApiAuthError`. (`getSnapshot` emits **no** remote
   telemetry itself; the retrieve orchestration event is owned by the service — see [§7](#7-error-telemetry).)
4. **Service catch.** `retrieveComponents`'s catch
   ([retrieve-service.ts:126-150](../src/shared/services/retrieve-service.ts#L126-L150)) computes
   `errorMessage`/`gackId`, emits a `DATACLOUD_DEVOPS_RETRIEVE_COMPONENT` failure event with
   `success: false` and `errorCode: err.code` (`'DataCloudApiAuthError'`), writes `diag.error`, then
   `throw err;` — the **same** `SfError`, re-thrown unchanged.
5. **Command → renderer.** The `SfError` escapes `run()` unhandled. `SfCommand` renders it: in human
   mode the user sees the message plus "Re-authenticate with `sf org login web` and try again."; in
   `--json` mode the standard error envelope with `name: 'DataCloudApiAuthError'`.

A **local** failure follows the same tail: e.g. a `ComponentNotFoundError` thrown by `readComponentFile`
during `sf data-cloud deploy` is caught by `deployComponents`'s catch
([deploy-service.ts:165-189](../src/shared/services/deploy-service.ts#L165-L189)), emitted as a
`DATACLOUD_DEVOPS_DEPLOY_COMPONENT` failure with its `errorCode`, then re-thrown unchanged to the
`SfCommand` renderer.

---

## 7. Error telemetry

On failure, the plugin attaches structured error fields to its telemetry events (emitted on the
`Lifecycle` telemetry channel via `emitTelemetry`, fire-and-forget). This section covers only the
_error_ fields; the full event catalog and delivery details are in [TELEMETRY.md](./TELEMETRY.md).

**Failure-event error fields:**

| Field          | Value                                                                                   | Where set                                                                                                                                                                                                          | Notes                                                                                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`      | `false`                                                                                 | all failure paths                                                                                                                                                                                                  | Distinguishes failure events from success events.                                                                                                                                                                                                                                                                                                 |
| `errorCode`    | the mapped `SfError.code` (API path) or `err.code` / `'UnexpectedError'` (service path) | [devops-api.ts:176](../src/shared/services/devops-api.ts#L176), [retrieve-service.ts:138](../src/shared/services/retrieve-service.ts#L138), [deploy-service.ts:177](../src/shared/services/deploy-service.ts#L177) | Bounded, machine-parseable. At the API boundary it is always one of the four codes from [§2](#2-error-classification-table). In services, a non-`SfError` falls back to the literal `'UnexpectedError'`.                                                                                                                                          |
| `errorMessage` | `errorMessageFrom(mapped)` — the **mapped** (redacted, actionable) message              | [devops-api.ts:167,177](../src/shared/services/devops-api.ts#L167), [telemetry.ts:79-82](../src/shared/services/telemetry.ts#L79-L82)                                                                              | **Only attached on error paths**, and only when truthy (`...(errorMessage && { errorMessage })`). Per a **Jun 2026 team decision** ([telemetry.ts:75-77](../src/shared/services/telemetry.ts#L75-L77)) this is intentionally unbounded free text — but it is the _mapped_ message, never the raw backend text. Success events carry no free text. |
| `gackId`       | `extractGackId(errorMessage)`                                                           | [devops-api.ts:168,178](../src/shared/services/devops-api.ts#L168)                                                                                                                                                 | **Currently always absent.** `GACK_EXTRACTION_ENABLED = false` ([telemetry.ts:94](../src/shared/services/telemetry.ts#L94)), so `extractGackId` returns `undefined` and the key is omitted (`...(gackId && { gackId })`). Wired up but disabled until the gack marker/format is confirmed with the backend.                                       |

**Which events carry these fields.** Not every boundary function emits telemetry:

- `getComponentTypes` and `getComponents` emit `DATACLOUD_DEVOPS_API_REQUEST` (success **and**
  failure) directly at the boundary.
- `getSnapshot`, `createPromotion`, and `getPromotionStatus` map errors but emit **no** telemetry —
  their orchestration events (`DATACLOUD_DEVOPS_RETRIEVE_COMPONENT`,
  `DATACLOUD_DEVOPS_DEPLOY_COMPONENT`, and the deploy-status poll) are owned by the respective
  services. This avoids a double-emit for a single logical operation.

**Worked failure event (matches the test at
[devops-api.test.ts:414-437](../test/shared/services/devops-api.test.ts#L414-L437)).** For the same
expired-session `getComponentTypes` request from [§3](#3-anatomy-of-an-sferror), the emitted
`DATACLOUD_DEVOPS_API_REQUEST` event is:

```jsonc
{
  "correlationId": "…", // a UUID, present on failure too
  "operation": "componentTypes",
  "success": false,
  "resultCount": 0,
  "durationMs": 12,
  "errorCode": "DataCloudApiAuthError", // the mapped code
  "errorMessage": "Your session is invalid or expired while trying to list component types."
  // no "message" key   — raw text never lands under `message`
  // no "gackId" key     — extraction disabled
  // no "Session expired" anywhere — raw backend text never leaks
}
```

The test verifies exactly these invariants: `success === false`, `errorCode === 'DataCloudApiAuthError'`,
`resultCount === 0`, the `errorMessage` includes "session is invalid or expired", the keys do **not**
include `message` or `gackId`, and `JSON.stringify(e)` does **not** match `/Session expired/`.
A separate resilience test ([devops-api.test.ts:463-475](../test/shared/services/devops-api.test.ts#L463-L475))
confirms that a **throwing** telemetry listener never masks the mapped `SfError` — telemetry is
fire-and-forget and cannot alter error propagation.

---

## Conflicts with CLAUDE.md / PROJECT_KNOWLEDGE.md

The following are places where the **code** (source of truth) diverges from the prose docs. They are
recorded here for the handoff reader; none are bugs in the error-handling logic.

1. **Endpoint paths.** [CLAUDE.md](../CLAUDE.md) documents the endpoints as `/ssot/devops/retrieve`,
   `/ssot/devops/deploy`, `/ssot/devops/deploy/{jobId}/status`, and
   `/ssot/devops/component-object-api-names`. The code instead calls `.../component/snapshot`,
   `.../component/promotion`, `.../component/promotion/{jobId}`, and `.../component/catalog`
   ([devops-api.ts:222,300,355,402](../src/shared/services/devops-api.ts#L222)). The `op` phrases in
   mapped error messages ("retrieve snapshot", "deploy components", "check deploy status") describe the
   _logical_ operation, so user-facing error text is unaffected — but the documented paths are stale.
2. **`SEND_CORRELATION_HEADER` ships disabled** ([devops-api.ts:58](../src/shared/services/devops-api.ts#L58))
   with a **placeholder** header name `'x-correlation-id'`
   ([devops-api.ts:57](../src/shared/services/devops-api.ts#L57)). CLAUDE.md's observability section
   asserts "correlation IDs across CLI → Connect API → DataKit"; in reality the correlationId is
   currently only emitted in telemetry, not sent on the wire. The real header name is an open
   question for the backend owner.
3. **`gackId` is wired but disabled** ([telemetry.ts:94](../src/shared/services/telemetry.ts#L94)).
   The observability guidance implies gack correlation; the code deliberately withholds it until the
   backend confirms whether `/ssot/devops/*` errors carry a gack id and in what format. The regex in
   [telemetry.ts:95](../src/shared/services/telemetry.ts#L95) is "a starting guess, not a contract".
4. **No bespoke error subclasses.** The docs speak of named errors; in code every one is a plain
   `SfError` distinguished only by its `code` string. This is intentional (it is what `SfCommand`
   renders and what `--json` consumers key on), but worth stating so a reader doesn't hunt for classes
   that don't exist.
