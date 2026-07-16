# Telemetry

How `@salesforce/plugin-datacloud-devops` emits observability signals, what those signals contain, and — just as importantly — what they are guaranteed **not** to contain.

> **Scope note.** This plugin owns the **CLI** (Layer 1) and the **Connect API contracts** (Layer 2 representation classes). It does **not** own the Connect API implementation, the server-side spidering, or the DataKit Orchestration Layer (Layer 3). Nothing in this document — and nothing the CLI emits — surfaces DataKit internals (DataKit names, template names, encoded XML, or internal dependency objects). Telemetry describes the CLI's own behavior only.

> **Two independent channels.** This document covers **remote telemetry** — anonymous, aggregate operational metrics that leave the machine. It is a completely separate mechanism from the **local diagnostic log** (an on-disk NDJSON file that never leaves the machine). The two share field _names_ on purpose (so a support engineer greps the local log with the same keys they see remotely) but are different code paths with different privacy rules. For the local channel see [DIAGNOSTICS.md](DIAGNOSTICS.md). For the design rationale behind both, see [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md).

---

## Table of contents

1. [Philosophy](#1-philosophy)
2. [The emit path](#2-the-emit-path)
3. [Event catalog](#3-event-catalog)
4. [The `TelemetryAttributes` type constraint](#4-the-telemetryattributes-type-constraint)
5. [Privacy model](#5-privacy-model)
6. [The gack-extraction story](#6-the-gack-extraction-story)
7. [Correlation ID flow](#7-correlation-id-flow)
8. [The `DEPLOY_COMPONENT_FAILURE` sub-event](#8-the-deploy_component_failure-sub-event)
9. [Testing telemetry](#9-testing-telemetry)
10. [How to add a new telemetry event](#10-how-to-add-a-new-telemetry-event)

---

## 1. Philosophy

Telemetry in this plugin is governed by four rules, in priority order. All four are enforced in one place — [`src/shared/services/telemetry.ts`](../src/shared/services/telemetry.ts) — so they cannot drift across call sites.

1. **Best-effort.** Telemetry is a side channel. If it works, we get operational insight; if it doesn't, the user's command still succeeds. Nothing about a command's correctness depends on a telemetry event being delivered.
2. **Never block.** Emitting is fire-and-forget. Every call site uses `void emitTelemetry(...)`, so the promise is never awaited on the command's latency path. A slow or hung listener cannot slow down a `retrieve` or `deploy`.
3. **Never throw.** `emitTelemetry` wraps its body in `try/catch` and the `catch` simply returns. A listener that throws, or an emit that rejects, can never alter the command's return value or its error propagation. See [telemetry.ts:114-126](../src/shared/services/telemetry.ts#L114-L126).
4. **Privacy-first.** Only flat, non-PII-shaped primitives are attachable (enforced by the `TelemetryAttributes` type — [§4](#4-the-telemetryattributes-type-constraint)), component _types_ are shape-guarded before emit ([§5](#5-privacy-model)), and free text is the deliberate exception, not the default. Component _names_, dataspace names, file paths, and usernames are never attached to a normal event.

These rules are stated verbatim in the module header ([telemetry.ts:19-31](../src/shared/services/telemetry.ts#L19-L31)):

```ts
/*
 * Single telemetry chokepoint for the Data Cloud DevOps plugin (PROJECT_KNOWLEDGE.md §2.4, §4.4).
 * Plugins emit domain-specific signals on the shared Lifecycle 'telemetry' channel; the sf CLI's
 * telemetry infrastructure (not this plugin) subscribes, enriches with command/version/duration,
 * and uploads. We centralize three guarantees here so they cannot drift across call sites:
 *   1. NEVER THROW / NEVER BLOCK — the body is try/caught and callers use `void`, so a listener or
 *      emit failure can never alter a command's return value or error propagation.
 *   2. NAMING — every event name is a DATACLOUD_DEVOPS_<VERB>_<NOUN> constant passed through here.
 *   3. SAFE FIELDS ONLY — the attrs type is a flat map of primitives, so a caller cannot accidentally
 *      attach a nested object, a raw API body, or a component-name struct.
 * Emitting with no registered listener is a safe no-op in @salesforce/core (emit() only debug-logs
 * when there are zero listeners). Tests subscribe via Lifecycle.getInstance().onTelemetry(...).
 */
```

---

## 2. The emit path

The plugin does **not** ship a telemetry uploader. It only _emits_ domain events onto a shared channel; the Salesforce CLI's own telemetry infrastructure subscribes to that channel, enriches each event, and uploads it. The plugin's responsibility ends at the emit.

```
┌──────────────────────────┐
│  service call site        │   deploy-service.ts / retrieve-service.ts /
│  void emitTelemetry(...)   │   deploy-status-service.ts / devops-api.ts
└────────────┬─────────────┘
             │  (fire-and-forget; no await on latency path)
             ▼
┌──────────────────────────┐
│  emitTelemetry()          │   src/shared/services/telemetry.ts:114
│  - injects surface:'cli'   │   try { ... } catch { return; }
│  - spreads safe attrs      │
└────────────┬─────────────┘
             │  await Lifecycle.getInstance().emitTelemetry({ eventName, surface:'cli', ...attrs })
             ▼
┌──────────────────────────┐
│  @salesforce/core          │   the shared 'telemetry' Lifecycle channel.
│  Lifecycle (event bus)     │   Zero listeners => safe no-op (debug log only).
└────────────┬─────────────┘
             │  (sf CLI telemetry infra is the subscriber, NOT this plugin)
             ▼
┌──────────────────────────┐
│  sf CLI telemetry infra    │   enriches with command / plugin version / duration,
│  (out of plugin scope)     │   then uploads.
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│  Azure Application Insights│   where CLI telemetry actually lands (see conflict note below).
└──────────────────────────┘
```

The single emit call is [telemetry.ts:120](../src/shared/services/telemetry.ts#L120):

```ts
await Lifecycle.getInstance().emitTelemetry({ eventName, surface: 'cli', ...attributes });
```

Key facts, each grounded in code:

- **`Lifecycle` is imported from `@salesforce/core`** — [telemetry.ts:17](../src/shared/services/telemetry.ts#L17): `import { Connection, Lifecycle } from '@salesforce/core';`. The plugin uses the framework's shared singleton bus; it does not construct its own.
- **`surface: 'cli'` is injected into every event** — see [telemetry.ts:120](../src/shared/services/telemetry.ts#L120). This distinguishes the CLI from future MCP / Agentforce surfaces (comment at [telemetry.ts:116-119](../src/shared/services/telemetry.ts#L116-L119)). Call sites never set `surface`; the chokepoint owns it.
- **Zero listeners is a safe no-op.** `@salesforce/core`'s `emitTelemetry` only debug-logs when there are no subscribers, so emitting during local dev (no telemetry infra attached) does nothing observable and costs nothing.
- **The plugin does not enrich.** `command`, plugin version, and duration are added downstream by the sf CLI infra — not by this plugin. The plugin _does_ attach its own `durationMs` (the service-level operation time) as a distinct, plugin-owned measurement.

> **⚠️ Conflict — Splunk vs. Azure App Insights.** `CLAUDE.md` and PROJECT_KNOWLEDGE.md describe observability as "structured logs → Splunk". In reality, **`sf` CLI telemetry emitted via `Lifecycle.emitTelemetry` lands in Azure Application Insights**, not Splunk — there is no CLI→Splunk forwarder for this channel. The code itself is agnostic (it only calls `Lifecycle.emitTelemetry`), so this is a documentation/mental-model correction rather than a code bug. Backend Connect API / DataKit logs (Layer 3, out of scope) may still go to Splunk; that is a different pipeline. **Follow the code + App Insights reality.**

---

## 3. Event catalog

Every event name is a `DATACLOUD_DEVOPS_<VERB>_<NOUN>` string literal passed to `emitTelemetry`. There are **five** distinct event names, emitted from four service files. Each row below is exhaustive for that emit site: it lists every field the code attaches, and marks fields that are attached _conditionally_ (spread as `...(x && { x })`, i.e. omitted when falsy/absent) with **(cond.)**.

`surface: 'cli'` is added by the chokepoint to **every** event and is omitted from the per-event rows below to avoid repetition.

| Event Name                                  | Emitted By (`file:line`)                                                                                                                                                                                                                                                                                        | Success fields                                                                                                                                                                                                                                           | Failure fields                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATACLOUD_DEVOPS_API_REQUEST`              | [`devops-api.ts:150`](../src/shared/services/devops-api.ts#L150) (`getComponentTypes`, success) / [`:169`](../src/shared/services/devops-api.ts#L169) (failure); [`:224`](../src/shared/services/devops-api.ts#L224) (`getComponents`, success) / [`:245`](../src/shared/services/devops-api.ts#L245) (failure) | `correlationId`, `operation` (`'componentTypes'` \| `'components'`), `orgId` **(cond.)**, `success: true`, `resultCount`, `durationMs`; **`componentType`** (only for `getComponents`, via `safeComponentType`)                                          | `correlationId`, `operation`, `componentType` (only for `getComponents`), `orgId` **(cond.)**, `success: false`, `resultCount: 0`, `durationMs`, `errorCode`, `errorMessage` **(cond.)**, `gackId` **(cond.)**            |
| `DATACLOUD_DEVOPS_RETRIEVE_COMPONENT`       | [`retrieve-service.ts:109`](../src/shared/services/retrieve-service.ts#L109) (success) / [`:129`](../src/shared/services/retrieve-service.ts#L129) (failure)                                                                                                                                                    | `correlationId`, `componentType` (via `safeComponentType`), `orgId` **(cond.)**, `success: true`, `componentCount`, `dependencyCount`, `hadDependencies`, `durationMs`                                                                                   | `correlationId`, `componentType`, `orgId` **(cond.)**, `success: false`, `componentCount: 0`, `dependencyCount: 0`, `hadDependencies: false`, `durationMs`, `errorCode`, `errorMessage` **(cond.)**, `gackId` **(cond.)** |
| `DATACLOUD_DEVOPS_DEPLOY_COMPONENT`         | [`deploy-service.ts:146`](../src/shared/services/deploy-service.ts#L146) (success) / [`:168`](../src/shared/services/deploy-service.ts#L168) (failure)                                                                                                                                                          | `correlationId`, `componentType` (via `safeComponentType`), `orgId` **(cond.)**, `success: true`, `componentCount`, `dependencyCount`, `hadDependencies`, `lifecycleStatus` (e.g. `'SUBMITTED'`), `durationMs`                                           | `correlationId`, `componentType`, `orgId` **(cond.)**, `success: false`, `componentCount: 0`, `dependencyCount: 0`, `hadDependencies: false`, `durationMs`, `errorCode`, `errorMessage` **(cond.)**, `gackId` **(cond.)** |
| `DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL`       | [`deploy-status-service.ts:132`](../src/shared/services/deploy-status-service.ts#L132) (success/terminal path) / [`:177`](../src/shared/services/deploy-status-service.ts#L177) (failure)                                                                                                                       | `correlationId`, `orgId` **(cond.)**, `lifecycleStatus`, `isTerminal`, `success` (= `status === 'SUCCESS'`), `componentCount`, `hadComponentError`, `durationMs`, `errorCode` **(cond.** — only on a terminal `FAILED`, via `deriveDeployErrorCode`**)** | `correlationId`, `orgId` **(cond.)**, `success: false`, `durationMs`, `errorCode`, `errorMessage` **(cond.)**, `gackId` **(cond.)**                                                                                       |
| `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` | [`deploy-status-service.ts:161`](../src/shared/services/deploy-status-service.ts#L161) (one per FAILED component)                                                                                                                                                                                               | _(emitted only for failed components — see [§8](#8-the-deploy_component_failure-sub-event))_                                                                                                                                                             | `correlationId`, `orgId` **(cond.)**, `componentType` **(raw**, per-component**)**, `componentName` **(raw**, per-component**)**, `failedIndex`, `failedCount`, `errorMessage` **(cond.)**, `gackId` **(cond.)**          |

Notes that matter when reading the catalog:

- **`errorCode` values.** On `RETRIEVE_COMPONENT`, `DEPLOY_COMPONENT`, and the `DEPLOY_STATUS_POLL` failure path, `errorCode` is `err instanceof SfError ? err.code : 'UnexpectedError'`. On the `DEPLOY_STATUS_POLL` terminal-failure success path it is `deriveDeployErrorCode(...)` → `'ComponentValidationError'` (a specific component broke) or `'DeployJobFailed'` (job-level failure) ([deploy-status-service.ts:87-89](../src/shared/services/deploy-status-service.ts#L87-L89)). On `API_REQUEST` it is the mapped `SfError.code` from `toSfError` (e.g. `DataCloudApiNetworkError`, `DataCloudApiAuthError`, `DataCloudApiNotFoundError`, `DataCloudApiError`).
- **`operation` on `API_REQUEST`** is a bounded literal (`'componentTypes'` or `'components'`), never a URL or query string. The query string and dataspace are deliberately never attached.
- **`componentType` is `safeComponentType`-guarded** on `API_REQUEST` / `RETRIEVE_COMPONENT` / `DEPLOY_COMPONENT` (bounded TYPE only). On `DEPLOY_COMPONENT_FAILURE` it is the **raw** value — a documented, scoped exception ([§8](#8-the-deploy_component_failure-sub-event)).
- **Which functions emit nothing.** `getSnapshot`, `createPromotion`, and `getPromotionStatus` in `devops-api.ts` deliberately emit no telemetry — the orchestration event (carrying the correlationId) is emitted by their owning service instead (`retrieve-service`, `deploy-service`, `deploy-status-service`). This avoids a double-count. See the doc comments at [devops-api.ts:325-336](../src/shared/services/devops-api.ts#L325-L336) and [:380-386](../src/shared/services/devops-api.ts#L380-L386).

> **Note on `deploy` telemetry.** The `DATACLOUD_DEVOPS_DEPLOY_COMPONENT` event _does_ attach a `correlationId` today (see [deploy-service.ts:99](../src/shared/services/deploy-service.ts#L99) and `:147`), and `createPromotion` receives it ([:134](../src/shared/services/deploy-service.ts#L134)). The chokepoint comment at [telemetry.ts:119](../src/shared/services/telemetry.ts#L119) still describes deploy/deploy-status as "mock-only events" that omit the correlationId — that comment predates the backend going live and is now stale. **Follow the code: deploy and deploy-status both mint and emit a real `correlationId`.**

---

## 4. The `TelemetryAttributes` type constraint

Every set of attributes passed to `emitTelemetry` must satisfy one type ([telemetry.ts:33-34](../src/shared/services/telemetry.ts#L33-L34)):

```ts
/** Only flat, non-PII-shaped primitives may be attached to a telemetry event. */
export type TelemetryAttributes = Record<string, string | number | boolean>;
```

Two constraints are doing the work here:

1. **Flat** — the value type is a _primitive union_, not `unknown` or `object`. A caller physically cannot pass a nested object, an array, a raw API response body, or a `{ componentName, componentType }` struct. The TypeScript compiler rejects it at the call site, before any data can reach the wire.
2. **Primitive** — values are `string | number | boolean` only. That is exactly the shape telemetry backends index cleanly (counts, durations, flags, codes, bounded type names). No serialization ambiguity, no accidental `[object Object]`, no deep payloads.

Why flat matters beyond ergonomics: the most dangerous way to leak PII is _accidentally_ — e.g. attaching a whole component or a whole API response "for context." A nested-object type would make that a one-liner. Forcing every attribute to be a hand-chosen primitive makes each field a deliberate decision, and makes the [privacy tests](#9-testing-telemetry) able to reason about the event as a flat key/value map.

This is the type-level half of the "SAFE FIELDS ONLY" guarantee from the module header ([telemetry.ts:27-28](../src/shared/services/telemetry.ts#L27-L28)); the value-level half is the privacy model in [§5](#5-privacy-model).

---

## 5. Privacy model

The type constraint stops _structural_ leaks. Three helpers stop _value_ leaks. All three live in `telemetry.ts` and are shared by every emit site.

### 5.1 `safeComponentType()` — shape guard

[telemetry.ts:36-56](../src/shared/services/telemetry.ts#L36-L56):

```ts
/** Shape a component type must have to be safe on telemetry: a PascalCase-style identifier. */
const COMPONENT_TYPE_SHAPE = /^[A-Za-z][A-Za-z0-9]*$/;
/** Upper bound on a component-type length attached to telemetry, to reject pathological strings. */
const MAX_COMPONENT_TYPE_LENGTH = 64;

export function safeComponentType(componentType: string): string {
  return typeof componentType === 'string' &&
    componentType.length <= MAX_COMPONENT_TYPE_LENGTH &&
    COMPONENT_TYPE_SHAPE.test(componentType)
    ? componentType
    : 'other';
}
```

The `--component` (`TYPE:NAME`) and `--component-type` flags are free text the CLI does not validate, so a user could type `--component-type /Users/me/secret` or `acct@corp.com`. Without a guard, that free text would flow straight onto telemetry. `safeComponentType` guards by **shape, not by an allowlist**:

- A bounded-length (`≤ 64`), separator-free identifier passes through **unchanged** — so a genuinely new backend type like `DataMesh` is reported faithfully, even though the CLI has never heard of it. (The CLI no longer keeps a hardcoded type catalog; folder names are derived at runtime, so a static allowlist would be wrong.)
- Anything containing a path separator, space, `@`, `:`, `.`, hyphen, or any other non-identifier character — or that is empty, blank, or pathologically long — collapses to the literal `'other'`.

This means a path or email can **never** leak through the `componentType` field: the worst case is the constant `'other'`. This exact behavior is pinned by [`telemetry.test.ts`](../test/shared/services/telemetry.test.ts) — PascalCase and brand-new types pass through; paths, emails, `Type:Name`, spaces, kebab-case, empty, blank, and 65-char strings all become `'other'`.

### 5.2 `safeOrgId()` — guarded extraction

[telemetry.ts:58-71](../src/shared/services/telemetry.ts#L58-L71):

```ts
export function safeOrgId(conn: Connection): string | undefined {
  try {
    return conn.getAuthInfoFields().orgId;
  } catch {
    return undefined;
  }
}
```

An org ID (`00D…`) is a non-PII _org_ identifier, and it is the join key that lets an operator correlate a telemetry event to a specific customer org. But `getAuthInfoFields()` can throw or return no `orgId` on a connection with incomplete auth info. `safeOrgId` guards that: on any failure it returns `undefined`. Every call site then spreads it **conditionally** — `...(orgId && { orgId })` — so a missing id is _omitted_ rather than emitted as a placeholder like `''` or `'undefined'`. An org ID trips none of the privacy guards in [`telemetry-test-utils.ts`](../test/shared/telemetry-test-utils.ts).

### 5.3 `errorMessageFrom()` — the deliberate free-text exception

[telemetry.ts:73-82](../src/shared/services/telemetry.ts#L73-L82):

```ts
export function errorMessageFrom(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : undefined;
}
```

Unlike every other telemetry value, `errorMessage` is intentionally **not bounded**. A June 2026 team decision allows the raw mapped `SfError` message on **failure events** for production debugging, accepting that it may contain backend or customer detail (correlated by `orgId`). The discipline that keeps this safe:

- **Only error paths attach it.** Success events carry no free text at all.
- **It is always conditional** (`...(errorMessage && { errorMessage })`) — absent when there is no message.
- The test harness treats `errorMessage` as an explicitly-listed _free-text exception key_ rather than a leak ([§9](#9-testing-telemetry)).

### What is allowed vs. forbidden on a success event

|                                 | Allowed on success events                                                                                                                    | Forbidden on success events                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Counts / durations**          | `componentCount`, `dependencyCount`, `resultCount`, `failedCount`, `durationMs`                                                              | —                                                                                                 |
| **Flags**                       | `success`, `hadDependencies`, `hadComponentError`, `isTerminal`                                                                              | —                                                                                                 |
| **Bounded strings**             | `correlationId` (UUID), `orgId` (`00D…`), `operation` (literal), `lifecycleStatus`, `errorCode`, `componentType` **via `safeComponentType`** | Raw/unbounded `componentType`                                                                     |
| **Free text**                   | _(none)_                                                                                                                                     | `errorMessage`, and any raw string — belongs only on failure events                               |
| **Identifiers of user content** | _(none)_                                                                                                                                     | `componentName`, `dataspaceName`/`dataSpaceName`, file paths, `manifestPath`, `username`, `email` |

The one deliberate exception to the "no `componentName`, no free text" rule is a _failure_ sub-event, described in [§8](#8-the-deploy_component_failure-sub-event).

---

## 6. The gack-extraction story

A Salesforce "gack" is a server-side exception with a unique id (canonical shape ≈ `NNNNNNNNN-NNNNNN`). If the CLI could capture that id from an error, an operator could pair a CLI failure with the exact server-side gack. The plumbing exists but ships **disabled**.

[telemetry.ts:84-101](../src/shared/services/telemetry.ts#L84-L101):

```ts
// `: boolean` (not the literal `false`) so the guard below is a real runtime check, not narrowed to
// dead code that the no-unnecessary-condition lint rule would reject. Flip to true to enable.
const GACK_EXTRACTION_ENABLED: boolean = false;
const GACK_ID_RE = /\b\d{6,}-\d{3,}\b/;

/** Extracts a gack id from an error message, or undefined while extraction is disabled/unmatched. */
export function extractGackId(message: string | undefined): string | undefined {
  if (!GACK_EXTRACTION_ENABLED || !message) return undefined;
  return GACK_ID_RE.exec(message)?.[0];
}
```

**Current state: DISABLED.** `GACK_EXTRACTION_ENABLED` is `false`, so `extractGackId` always returns `undefined`. Consequently the `gackId` field — spread conditionally as `...(gackId && { gackId })` — is **never attached to any event today**, even though every failure path calls `extractGackId(...)`.

**The code path.** Each service failure branch computes `const errorMessage = errorMessageFrom(err); const gackId = extractGackId(errorMessage);` and then conditionally spreads `gackId`. (For `DEPLOY_COMPONENT_FAILURE` the input is the per-component `c.error` — [deploy-status-service.ts:159-160](../src/shared/services/deploy-status-service.ts#L159-L160).) Because the flag is off, the extractor short-circuits at the first clause and returns `undefined` before the regex ever runs.

**Why it's off.** There is **no dedicated gack field** on the API error response, so an id — if present at all — would only appear embedded in the message string. It is **unverified** whether the `/ssot/devops/*` endpoints even surface a gack id in their error bodies. Shipping extraction off keeps false-positive ids (numbers that merely _look_ like a gack) out of telemetry until a real gack-bearing error confirms the marker and format with the backend owner. The regex is explicitly "a starting guess, not a contract" ([telemetry.ts:90-91](../src/shared/services/telemetry.ts#L90-L91)).

**How to enable it.** There is **no environment variable or flag** — this is a deliberate compile-time gate. To turn it on:

1. Confirm with the backend owner that `/ssot/devops/*` errors actually carry a gack id, and confirm its exact marker/format.
2. Update `GACK_ID_RE` in [telemetry.ts:95](../src/shared/services/telemetry.ts#L95) to match the confirmed format (the current value is a guess).
3. Flip `GACK_EXTRACTION_ENABLED` to `true` at [telemetry.ts:94](../src/shared/services/telemetry.ts#L94).

The `: boolean` annotation (rather than the literal `false`) is intentional — it keeps the `if (!GACK_EXTRACTION_ENABLED ...)` check a real runtime branch so the `no-unnecessary-condition` lint rule doesn't flag it as dead code, and so flipping the constant is the only change needed.

---

## 7. Correlation ID flow

A correlation ID is a client-generated CLI-side trace id — one per user-facing operation — that ties together every signal that operation produces.

**Minted per operation.** Each orchestrating service mints one `randomUUID()` at the top of the call:

| Service       | Mint site                                                                            |
| ------------- | ------------------------------------------------------------------------------------ |
| retrieve      | [retrieve-service.ts:63](../src/shared/services/retrieve-service.ts#L63)             |
| deploy        | [deploy-service.ts:99](../src/shared/services/deploy-service.ts#L99)                 |
| deploy status | [deploy-status-service.ts:105](../src/shared/services/deploy-status-service.ts#L105) |

The read commands (`getComponentTypes` / `getComponents`) mint theirs at the `devops-api` boundary via a defaulted parameter — `correlationId: string = randomUUID()` ([devops-api.ts:134](../src/shared/services/devops-api.ts#L134), [:200](../src/shared/services/devops-api.ts#L200)) — because there is no higher orchestrator for those.

**Emitted in telemetry.** `correlationId` is the first attribute on every one of the five events (see [§3](#3-event-catalog)). Where an orchestrator calls into `devops-api`, it passes its own id down so the HTTP-layer diagnostics reuse the same id (e.g. `getSnapshot(conn, ..., correlationId)` at [retrieve-service.ts:84](../src/shared/services/retrieve-service.ts#L84); `createPromotion(conn, request, correlationId)` at [deploy-service.ts:134](../src/shared/services/deploy-service.ts#L134)). The same id is also handed to the local diagnostic logger (`getDiagLogger().begin({ ..., correlationId })`) so the on-disk log ([DIAGNOSTICS.md](DIAGNOSTICS.md)) joins to the telemetry by one id.

**The future request-header plan.** Today the correlationId is emitted but **not** sent to the backend as a request header — so the backend's own logs can't yet be joined to a CLI event. That propagation is gated, and the gate lives in **`devops-api.ts`, not `telemetry.ts`** ([devops-api.ts:47-58](../src/shared/services/devops-api.ts#L47-L58)):

```ts
export const CORRELATION_ID_HEADER = 'x-correlation-id';
const SEND_CORRELATION_HEADER: boolean = false;
```

- `SEND_CORRELATION_HEADER` is `false`. While off, every request is built byte-for-byte as it is today — a bare URL string for GETs, `Content-Type` only for the POST — so no behavior changes and no unrecognized header is ever sent. This is enforced by two small helpers: `correlationHeaders(...)` returns `{}` when off ([devops-api.ts:65-68](../src/shared/services/devops-api.ts#L65-L68)), and `getRequest(...)` returns a bare URL string when off ([devops-api.ts:76-81](../src/shared/services/devops-api.ts#L76-L81)).
- `CORRELATION_ID_HEADER = 'x-correlation-id'` is a **placeholder**. The header name the Connect API actually reads for request correlation could not be determined from code and **must be confirmed with the backend owner** before enabling.
- To enable: confirm the real header name, set `CORRELATION_ID_HEADER` to it, and flip `SEND_CORRELATION_HEADER` to `true`. `correlationHeaders` / `getRequest` are exported and parameterized (`enabled` defaults to the module gate) precisely so the enabled shape is unit-testable without shipping it on.

> The comment in `telemetry.ts` at [:116-119](../src/shared/services/telemetry.ts#L116-L119) references "propagating it as a request header … awaits the backend trace-header contract" — but the actual gate and header constant live in `devops-api.ts`, as shown above. `telemetry.ts` only _emits_ the id; it does not own header propagation.

---

## 8. The `DEPLOY_COMPONENT_FAILURE` sub-event

`DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` is a **sub-event of the deploy-status poll**, not of `deploy`. It is emitted from [`deploy-status-service.ts`](../src/shared/services/deploy-status-service.ts) — once **per FAILED component** — after the main `DEPLOY_STATUS_POLL` event, sharing that poll's `correlationId` so they join.

[deploy-status-service.ts:152-171](../src/shared/services/deploy-status-service.ts#L152-L171):

```ts
// Per-component failure detail (§5.7, Jun 2026 decision): one sub-event per FAILED component,
// sharing the poll's correlationId so they join. Unlike the bounded poll event, this deliberately
// carries the customer's OWN componentName + error reason for production debugging (the privacy
// relaxation is scoped to this event name only). `lineNumber` is omitted — no such field exists in
// the backend contract. emitTelemetry stays fire-and-forget, so this never affects the result.
const failed = components.filter((c) => c.status === 'FAILED');
failed.forEach((c, failedIndex) => {
  const componentErrorMessage = errorMessageFrom(c.error);
  const gackId = extractGackId(c.error);
  void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE', {
    correlationId,
    ...(orgId && { orgId }),
    componentType: c.componentType,
    componentName: c.componentName,
    failedIndex,
    failedCount: failed.length,
    ...(componentErrorMessage && { errorMessage: componentErrorMessage }),
    ...(gackId && { gackId }),
  });
});
```

**Documented privacy relaxation.** This is the single event where the normal rules are deliberately relaxed:

- `componentType` is the **raw** per-component value — **not** run through `safeComponentType`.
- `componentName` — a field forbidden on every other event — **is attached**, raw.
- `errorMessage` carries the per-component `c.error` reason (conditionally).

**Why it's allowed here.** When a deploy job fails, the operator's single most useful question is _which component broke, and why_. A bounded poll event can say "one component failed" but not which one. This sub-event answers that — and the relaxation is **scoped to this event name only** and to a _failure_ condition. The `FORBIDDEN_KEYS` privacy check in the test harness explicitly exempts `componentName`, `componentType`, and `errorMessage` **only** for `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` ([§9](#9-testing-telemetry)); the same fields on any other event are still a hard test failure.

`failedIndex` (0-based position within the failed set) and `failedCount` (total number failed) let a consumer reassemble the full failure list from the individual sub-events. `lineNumber` is deliberately **not** emitted — no such field exists in the backend contract, and inventing one is forbidden.

---

## 9. Testing telemetry

Telemetry is testable because it flows over the shared `Lifecycle` bus: a test subscribes to the same channel the sf CLI infra would, drives a command, and asserts on the captured events. The shared harness is [`test/shared/telemetry-test-utils.ts`](../test/shared/telemetry-test-utils.ts).

### Subscribe / reset / filter

[telemetry-test-utils.ts:36-51](../test/shared/telemetry-test-utils.ts#L36-L51):

```ts
export function captureTelemetry(sink: TelemetryEvent[]): void {
  // Subscribe to the same 'telemetry' Lifecycle channel the sf CLI telemetry infra uses. onTelemetry
  // is synchronous, so events land in `sink` in emit order before the awaited command returns.
  Lifecycle.getInstance().onTelemetry((data: Record<string, unknown>): Promise<void> => {
    sink.push(data);
    return Promise.resolve();
  });
}

export function resetTelemetry(): void {
  Lifecycle.getInstance().removeAllListeners(Lifecycle.telemetryEventName);
}

export function ourEvents(sink: TelemetryEvent[]): TelemetryEvent[] {
  return sink.filter((e) => typeof e.eventName === 'string' && e.eventName.startsWith('DATACLOUD_DEVOPS_'));
}
```

- `captureTelemetry(sink)` registers an `onTelemetry` listener that pushes each event into `sink`. Because `onTelemetry` fires synchronously, events are in `sink` in emit order by the time the awaited command returns.
- `resetTelemetry()` removes all listeners (call it in `afterEach` so tests don't cross-contaminate).
- `ourEvents(sink)` narrows to this plugin's events (`DATACLOUD_DEVOPS_*`), filtering out any framework noise.

### The privacy contract

The harness also _enforces_ the privacy model at test time. [telemetry-test-utils.ts:54-111](../test/shared/telemetry-test-utils.ts#L54-L111):

```ts
const FORBIDDEN_KEYS = [
  'componentName',
  'componentNames',
  'dataspace',
  'dataspaceName',
  'dataSpaceName',
  'fileWriteLocation',
  'filesWritten',
  'manifestPath',
  'path',
  'targetComponent',
  'message',
  'error',
  'username',
  'email',
];

// Values that must never appear literally — the fixture names + PII shapes (path separators, '@').
const UNSAFE_VALUE =
  /highValueCustomer|Divvy_Trips|myTransform|myDLO|AccountDmo|HighValueCustomers|analytics_ds|invalid syntax|Session expired|ENOTFOUND|[\\/]|@/;

// Free text is allowed ONLY on these keys/events (the Jun 2026 decision).
const FREE_TEXT_KEYS = new Set(['errorMessage']);
const COMPONENT_FAILURE_EVENT = 'DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE';
const COMPONENT_FAILURE_FREE_TEXT_KEYS = new Set(['componentName', 'componentType', 'errorMessage']);

export function assertNoUnsafeFields(event: TelemetryEvent): void {
  /* … */
}

export function assertAllSafe(sink: TelemetryEvent[]): void {
  for (const event of ourEvents(sink)) {
    assertNoUnsafeFields(event);
  }
}
```

`assertNoUnsafeFields` fails a test if an event carries any `FORBIDDEN_KEYS` key, or any value matching `UNSAFE_VALUE` (fixture names, path separators, `@`) — **except** on the free-text exceptions: `errorMessage` anywhere, and `componentName` / `componentType` / `errorMessage` **only** on `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE`. This is the automated backstop for [§5](#5-privacy-model) and [§8](#8-the-deploy_component_failure-sub-event): if someone adds a field that leaks a component name onto the wrong event, the privacy suite goes red. `UUID_RE` ([telemetry-test-utils.ts:29](../test/shared/telemetry-test-utils.ts#L29)) is also exported so a test can assert a `correlationId` is a well-formed v4 UUID.

### Usage example

```ts
import { expect } from 'chai';
import { captureTelemetry, resetTelemetry, ourEvents, assertAllSafe, UUID_RE } from '../shared/telemetry-test-utils.js';

describe('retrieve telemetry', () => {
  const sink: TelemetryEvent[] = [];

  beforeEach(() => {
    sink.length = 0;
    captureTelemetry(sink);
  });
  afterEach(() => resetTelemetry());

  it('emits one safe RETRIEVE_COMPONENT success event', async () => {
    await retrieveComponents(conn, 'CalculatedInsight:someInsight');

    const events = ourEvents(sink);
    expect(events).to.have.lengthOf(1);

    const [event] = events;
    expect(event.eventName).to.equal('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT');
    expect(event.success).to.equal(true);
    expect(event.surface).to.equal('cli');
    expect(event.correlationId).to.match(UUID_RE);

    // The privacy backstop: no component names, paths, or fixture values on the wire.
    assertAllSafe(sink);
  });
});
```

The focused unit test [`test/shared/services/telemetry.test.ts`](../test/shared/services/telemetry.test.ts) additionally pins `safeComponentType` directly (PascalCase and brand-new types pass through; paths, emails, `Type:Name`, spaces, kebab-case, empty/blank/65-char all become `'other'`).

---

## 10. How to add a new telemetry event

Adding an event means following the existing pattern exactly — a new `DATACLOUD_DEVOPS_<VERB>_<NOUN>` constant, emitted through the chokepoint on both success and failure, with only safe fields. Below is the minimal shape (illustrative — do not invent a new command; use this when a real new operation lands).

**1. Emit at the operation's success and failure boundaries**, using `void`, the shared helpers, and conditional spreads. Mint a `correlationId` if this is a new top-level operation; otherwise thread the existing one.

```diff
  import { randomUUID } from 'node:crypto';
  import { Connection, SfError } from '@salesforce/core';
+ import { emitTelemetry, safeComponentType, safeOrgId, errorMessageFrom, extractGackId } from './telemetry.js';

  export async function widgetize(conn: Connection, component: string): Promise<WidgetResult> {
    const startedAt = Date.now();
+   const correlationId = randomUUID();
+   const orgId = safeOrgId(conn);
+   let componentType = 'unknown';
    try {
+     componentType = safeComponentType(parseComponentFlag(component).componentType);
      const result = await doTheWork(conn, component, correlationId);

+     void emitTelemetry('DATACLOUD_DEVOPS_WIDGETIZE_COMPONENT', {
+       correlationId,
+       componentType,
+       ...(orgId && { orgId }),
+       success: true,
+       widgetCount: result.widgets.length,
+       durationMs: Date.now() - startedAt,
+     });
      return result;
    } catch (err) {
+     const errorMessage = errorMessageFrom(err);
+     const gackId = extractGackId(errorMessage);
+     void emitTelemetry('DATACLOUD_DEVOPS_WIDGETIZE_COMPONENT', {
+       correlationId,
+       componentType,
+       ...(orgId && { orgId }),
+       success: false,
+       widgetCount: 0,
+       durationMs: Date.now() - startedAt,
+       errorCode: err instanceof SfError ? err.code : 'UnexpectedError',
+       ...(errorMessage && { errorMessage }),
+       ...(gackId && { gackId }),
+     });
      throw err; // re-throw the ORIGINAL error — propagation unchanged.
    }
  }
```

**2. Add the event and its fields to the [event catalog](#3-event-catalog) table** in this document — the catalog is meant to stay exhaustive.

**Checklist (each item maps to a rule above):**

- [ ] Name is `DATACLOUD_DEVOPS_<VERB>_<NOUN>`, uppercase (naming guarantee, [§1](#1-philosophy)).
- [ ] Emit through `emitTelemetry` — never call `Lifecycle.emitTelemetry` directly (single chokepoint).
- [ ] Call site uses `void`, and the failure branch still `throw`s the original error (never-block / never-throw, [§1](#1-philosophy)).
- [ ] Every attribute is a flat primitive (`TelemetryAttributes`, [§4](#4-the-telemetryattributes-type-constraint)).
- [ ] Any component type goes through `safeComponentType`; `orgId` via `safeOrgId` and spread conditionally ([§5](#5-privacy-model)).
- [ ] Free text (`errorMessage`) appears only on the failure path, spread conditionally ([§5.3](#53-errormessagefrom--the-deliberate-free-text-exception)).
- [ ] No `componentName`, dataspace, path, `username`, or `email` on the event — unless it is an explicitly-relaxed failure sub-event, in which case update `telemetry-test-utils.ts` too ([§8](#8-the-deploy_component_failure-sub-event)).
- [ ] Add a test that drives the code and calls `assertAllSafe(sink)` ([§9](#9-testing-telemetry)).

---

## See also

- [DIAGNOSTICS.md](DIAGNOSTICS.md) — the independent, local-only NDJSON diagnostic channel (snake_case keys, never leaves the machine) that shares field names with telemetry.
- [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) — the design rationale behind the never-throw/never-block, privacy-first, and single-chokepoint decisions.
