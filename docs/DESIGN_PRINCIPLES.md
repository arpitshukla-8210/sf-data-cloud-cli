# docs/DESIGN_PRINCIPLES.md (codified invariants)

This document is the contract every change to `@salesforce/plugin-datacloud-devops` must keep. Each
section states **a rule**, shows **the code that enforces it** (`file:line` + a verbatim snippet),
and explains **why it exists**. These are not style preferences — they are load-bearing invariants
that the tests, the on-disk format, and the observability channels all depend on. If you are a future
developer or an AI agent touching this codebase, read the principle before you change the file that
enforces it, and keep the enforcement in place.

> **Source of truth.** These principles are extracted from the code as it exists today. Where the
> code and the planning docs (`CLAUDE.md`, `PROJECT_KNOWLEDGE.md`) disagree, **the code wins** and the
> discrepancy is flagged inline in a `> Note` block. A consolidated list is in
> [Appendix A: Code-vs-docs discrepancies](#appendix-a-code-vs-docs-discrepancies).

**Scope of ownership (unchanged from `CLAUDE.md`).** This plugin owns the **CLI (Layer 1)** and the
**Connect API contracts (Layer 2 representation classes)**. It does **not** own the Connect API
_implementation_, spidering, or the DataKit Orchestration Layer (Layer 3). Several principles below
(e.g. pass-through, thin client, no DataKit internals) exist precisely to keep the CLI on its side of
that boundary.

**Companion docs (read for depth):**

- [`docs/TELEMETRY.md`](./TELEMETRY.md) — the remote telemetry channel, event catalog, privacy model.
- [`docs/DIAGNOSTICS.md`](./DIAGNOSTICS.md) — the local NDJSON channel, levels, redaction, rotation.
- [`docs/ON_DISK_FORMAT.md`](./ON_DISK_FORMAT.md) — the `data-cloud/` tree, file shape, manifest.
- [`docs/ERROR_HANDLING.md`](./ERROR_HANDLING.md) — the structured-error model and error codes.
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — the three-layer model and thin-client boundary.

---

## Table of contents

1. [Thin Client Over Connect API](#1-thin-client-over-connect-api)
2. [Never Throw From Observability](#2-never-throw-from-observability)
3. [Structured, Actionable Errors](#3-structured-actionable-errors)
4. [Deterministic File Names](#4-deterministic-file-names)
5. [Self-Describing Files](#5-self-describing-files)
6. [Payload Pass-Through](#6-payload-pass-through)
7. [Privacy by Design in Telemetry](#7-privacy-by-design-in-telemetry)
8. [Redaction as a Security Boundary](#8-redaction-as-a-security-boundary)
9. [Correlation ID Threading](#9-correlation-id-threading)
10. [No Side Effects at Import](#10-no-side-effects-at-import)
11. [Separation of Channels](#11-separation-of-channels)
12. [Runtime Extensibility Over Catalogs](#12-runtime-extensibility-over-catalogs)
13. [Conventional Commits + Modular Structure](#13-conventional-commits--modular-structure)

---

## 1. Thin Client Over Connect API

**Rule.** The CLI is presentation and orchestration only. All server behavior lives behind the
Connect API under `/ssot/devops/*`. Commands never make HTTP calls directly, never parse business
logic out of responses, and **never invent** endpoints, field names, or component types. There is a
single HTTP boundary — [`src/shared/services/devops-api.ts`](../src/shared/services/devops-api.ts) —
and every network call flows through it.

**Enforcing code.** The base path is always derived from the live connection's API version — it is
never hardcoded — and every function is exactly one `conn.request` against a `/ssot/devops/*` path.

[`src/shared/services/devops-api.ts:45`](../src/shared/services/devops-api.ts#L45)

```ts
const basePath = (conn: Connection): string => `/services/data/v${conn.getApiVersion()}/ssot/devops`;
```

The command layer holds no HTTP logic at all. A command resolves the org, delegates to a service, and
formats output — nothing more:

[`src/commands/data-cloud/deploy/index.ts:54`](../src/commands/data-cloud/deploy/index.ts#L54)

```ts
public async run(): Promise<DeployResult> {
  const { flags } = await this.parse(DataCloudDeploy);
  const conn = flags['target-org'].getConnection(flags['api-version']);

  // Service layer: parse the flag → read local files → walk deps → assemble the payload → POST.
  const result = await deployComponents(conn, flags.component, flags.dataspace);
  ...
```

**Why.** The whole project is defined as a "thin client over three Connect API endpoints." Keeping
the org-facing surface in one file means: the API version is resolved consistently (Data Cloud
features gate on `minVersion`), error translation happens in exactly one place (Principle 3), and the
server team can evolve the implementation without the CLI shipping stale assumptions. Inventing a
field or endpoint here would silently break the contract the backend owner maintains.

> **Note (code vs. docs).** The endpoint paths in the code differ from the summary table in
> `CLAUDE.md`. The code uses `component-types`, `component/catalog`, `component/snapshot`,
> `component/promotion`, and `component/promotion/{jobId}`
> ([devops-api.ts:147, :222, :300, :355, :402](../src/shared/services/devops-api.ts#L147)). `CLAUDE.md`
> lists `/retrieve`, `/deploy`, `/deploy/{jobId}/status`, and `component-object-api-names`. Follow the
> code. Do not "correct" the code to match the doc without confirming with the backend owner.

---

## 2. Never Throw From Observability

**Rule.** Neither observability channel may ever change a command's outcome. Telemetry
(`emitTelemetry`) and diagnostics (`DiagLogger`) are **fire-and-forget**: they swallow their own
failures and return normally. Callers invoke telemetry with `void` (so an unawaited rejection cannot
surface) and diagnostics are synchronous writes wrapped in `try/catch`. A broken listener, an
unwritable disk, or a redaction bug must never turn a successful command into a failed one.

**Enforcing code — telemetry.** The emit is wrapped and the `catch` deliberately returns:

[`src/shared/services/telemetry.ts:114`](../src/shared/services/telemetry.ts#L114)

```ts
export async function emitTelemetry(eventName: string, attributes: TelemetryAttributes): Promise<void> {
  try {
    await Lifecycle.getInstance().emitTelemetry({ eventName, surface: 'cli', ...attributes });
  } catch {
    // Telemetry is best-effort: a listener/emit failure must never reach the caller. A real
    // statement (not a bare comment) is required so the `no-empty` lint rule passes.
    return;
  }
}
```

Callers always use `void` so the promise is fire-and-forget:

[`src/shared/services/deploy-service.ts:146`](../src/shared/services/deploy-service.ts#L146)

```ts
void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_COMPONENT', {
  correlationId,
  componentType,
  ...
```

**Enforcing code — diagnostics.** The single write path is synchronous and `try/catch`-guarded; the
`catch` returns rather than rethrowing:

[`src/shared/diagnostics/logger.ts:162`](../src/shared/diagnostics/logger.ts#L162)

```ts
private write(level: LogLevel, subsystem: Subsystem, code: string, msg: string, extra?: DiagExtra): void {
  const sink = this.sink;
  if (sink === undefined || !this.levelEnabled(level, subsystem)) {
    return;
  }
  try {
    const event = this.buildEvent(sink, level, subsystem, code, msg, extra);
    const line = JSON.stringify(event) + '\n';
    sink.append(line, this.command, this.correlationId);
  } catch {
    // Fire-and-forget: a serialization/redaction/fs failure must never reach the caller. A real
    // statement (not a bare comment) keeps the `no-empty` lint rule satisfied (see telemetry.ts).
    return;
  }
}
```

**Why.** Observability is orthogonal to correctness. If instrumentation could throw, adding a metric
would become a risk to production behavior and engineers would stop adding it. The `void` on the
caller side is not decorative — without it, an unhandled promise rejection from a listener could crash
the process or fail the command. The empty-`catch` bodies use an explicit `return` only because the
`no-empty` lint rule rejects a bare `{}`; do not "simplify" them away.

> See [`docs/TELEMETRY.md`](./TELEMETRY.md) and [`docs/DIAGNOSTICS.md`](./DIAGNOSTICS.md) for the full
> best-effort contract of each channel.

---

## 3. Structured, Actionable Errors

**Rule.** Every error the CLI surfaces is an `SfError` carrying a **stable machine code**, a
**human-readable message**, and — where the user can do something — an **`actions[]`** list. No raw
gacks, no jsforce stack traces, and never "contact support." Low-level connection failures are
translated at the single HTTP boundary so callers stay thin.

**Enforcing code.** `toSfError` maps low-level failures onto four stable codes with actionable
guidance. The `default` case still produces a structured `SfError` with a code — never a bare throw:

[`src/shared/services/devops-api.ts:89`](../src/shared/services/devops-api.ts#L89)

```ts
function toSfError(err: unknown, op: string): SfError {
  const e = err as { name?: string; errorCode?: string; message?: string };
  const code = e?.errorCode ?? e?.name ?? '';
  const message = e?.message ?? String(err);
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
      ...
```

The four codes are `DataCloudApiNetworkError`, `DataCloudApiAuthError`, `DataCloudApiNotFoundError`,
and the catch-all `DataCloudApiError`
([devops-api.ts:99, :108, :117, :126](../src/shared/services/devops-api.ts#L99)). Input-validation
errors follow the same pattern with their own codes, e.g. `InvalidComponentFlagError`
([deploy-service.ts:50](../src/shared/services/deploy-service.ts#L50)),
`InvalidComponentTypeError` ([component-paths.ts:81](../src/shared/constants/component-paths.ts#L81)).

**Why.** The user of a CLI cannot open a debugger. A stable `code` lets scripts and tests branch on
failures; the `actions[]` list turns a dead end into a next step ("re-authenticate", "confirm Data
Cloud is enabled"). Translating at the single boundary means every command inherits the same quality
of error for free — a raw jsforce `HttpApiError` never leaks to a terminal. The `cause` is forwarded
only when it is a real `Error`, because `SfError` throws otherwise.

> Full error catalog and the mapping table: [`docs/ERROR_HANDLING.md`](./ERROR_HANDLING.md).

---

## 4. Deterministic File Names

**Rule.** A component's on-disk file is named by its **API name** (`<componentName>.json`), and its
**folder is derived at runtime** from the `componentType` — kebab-case, pluralized — never looked up
in a hardcoded catalog. The same input always produces the same path, so re-retrieving overwrites in
place and diffs stay clean.

**Enforcing code.** The path is assembled from a derived folder and the API-name file name:

[`src/shared/services/file-writer.ts:50`](../src/shared/services/file-writer.ts#L50)

```ts
function pathForComponent(component: RawRetrievedComponent, baseDir: string): string {
  const folder = folderForComponentType(component.componentType);
  const fileName = `${component.componentName}.json`;
  if (isRootRouted(component.componentType, component.dataspaceName)) {
    return join(baseDir, ROOT_DIR, folder, fileName);
  }
  return join(baseDir, ROOT_DIR, component.dataspaceName, folder, fileName);
}
```

The folder derivation is pure kebab + pluralize, with **no catalog**:

[`src/shared/constants/component-paths.ts:78`](../src/shared/constants/component-paths.ts#L78)

```ts
export function folderForComponentType(componentType: string): string {
  const kebab = toKebabCase(componentType?.trim() ?? '');
  if (kebab === '') {
    throw new SfError(
      `Component type "${componentType}" is empty or invalid; it must be a non-empty identifier.`,
      'InvalidComponentTypeError'
    );
  }
  return pluralize(kebab);
}
```

`toKebabCase` also collapses path characters (`/`, `\`, `:`, `..`, null bytes) into hyphens and trims
them, so a derived folder name **can never escape** the `data-cloud/` tree
([component-paths.ts:38](../src/shared/constants/component-paths.ts#L38)).

**Why.** Deterministic, API-name-based paths are the entire point of bringing source control to Data
Cloud: a component maps to one predictable file, so `git diff` is meaningful and re-retrieve is
idempotent. Deriving the folder at runtime (Principle 12) removes the maintenance burden and drift
risk of a hardcoded type→folder map. The single derivation function is shared by the writer and the
reader so deploy finds exactly what retrieve wrote.

> **Note (code vs. docs).** The hardcoded folder catalog referenced in earlier planning was **removed**
> (commit `47ae970`, "derive component folders at runtime instead of a hardcoded catalog"). Do not
> reintroduce a lookup table. See [`docs/ON_DISK_FORMAT.md`](./ON_DISK_FORMAT.md) for the full path
> algorithm and examples.

---

## 5. Self-Describing Files

**Rule.** Every component file carries five fields — `componentType`, `componentName`,
`dataspaceName`, `dependsOn[]`, `entityPayload` — so it is fully understandable **in isolation**,
without the manifest, the directory it lives in, or a live org. A file moved or read alone still
knows what it is and what it needs.

**Enforcing code.** The writer serializes exactly these five fields for every component:

[`src/shared/services/file-writer.ts:86`](../src/shared/services/file-writer.ts#L86)

```ts
const plannedFiles = components.map((component) => ({
  path: pathForComponent(component, options.baseDir),
  content: serialize({
    componentType: component.componentType,
    componentName: component.componentName,
    dataspaceName: component.dataspaceName ?? '',
    dependsOn: component.dependsOn,
    entityPayload: component.entityPayload,
  }),
}));
```

A null/absent `dataspaceName` is normalized to `''` (not omitted) so the field is always present and
the reader's required-field check still passes
([file-writer.ts:91](../src/shared/services/file-writer.ts#L91)). Files are written as human-readable,
2-space-indented JSON with a trailing newline ([file-writer.ts:60](../src/shared/services/file-writer.ts#L60)).

**Why.** Source control artifacts outlive the process that wrote them. A reviewer looking at a single
file in a PR, or a script reading one component out of the tree, must be able to answer "what type is
this, which dataspace, what does it depend on, what is the payload?" without cross-referencing
anything else. Normalizing `dataspaceName` to `''` rather than dropping it keeps the shape uniform so
downstream code never special-cases a missing key.

> The full field-by-field contract and the manifest's role live in
> [`docs/ON_DISK_FORMAT.md`](./ON_DISK_FORMAT.md).

---

## 6. Payload Pass-Through

**Rule.** `entityPayload` is opaque. The CLI stores it and transmits it **verbatim** — it is never
parsed, validated, reshaped, or re-serialized. A string stays a string; an object stays an object. A
retrieve→deploy round-trip preserves the payload byte-for-byte.

**Enforcing code — retrieve → disk.** The payload is passed straight through into the serialized file
(see the `entityPayload: component.entityPayload` line in the Principle 5 snippet,
[file-writer.ts:93](../src/shared/services/file-writer.ts#L93)) — no transform, no `JSON.parse`.

**Enforcing code — disk → deploy.** The deploy request is assembled by copying the on-disk fields
through unchanged:

[`src/shared/services/deploy-service.ts:68`](../src/shared/services/deploy-service.ts#L68)

```ts
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

The doc comment above it is explicit: the payload "stays under `entityPayload` (never re-parsed — a
string stays a string, an object stays an object)"
([deploy-service.ts:62](../src/shared/services/deploy-service.ts#L62)).

**Why.** The CLI does not own the schema of a component's payload — the backend and DataKit layer do.
The moment the CLI parses or "cleans up" a payload, it takes on a schema dependency it cannot honor,
risks lossy round-trips, and could accidentally surface or mangle internal structure. Treating the
payload as an opaque blob is how the CLI stays a thin client (Principle 1) and how it guarantees that
what you retrieved is exactly what you deploy.

---

## 7. Privacy by Design in Telemetry

**Rule.** Remote telemetry carries **only flat primitives** (counts, durations, booleans, structured
codes, bounded type names). Component names, file paths, and dataspace names are **never** attached to
success events. There are exactly **two deliberate exceptions**, both documented at the emit site: an
`errorMessage` on error-path events, and the `componentName`/reason on the
`DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` sub-event.

**Enforcing code — the type is the guardrail.** The attribute type physically prevents nesting a raw
object or payload:

[`src/shared/services/telemetry.ts:34`](../src/shared/services/telemetry.ts#L34)

```ts
export type TelemetryAttributes = Record<string, string | number | boolean>;
```

**Enforcing code — component types are shape-bounded.** A free-text `--component-type` cannot leak a
path or email into telemetry; anything that is not a bounded, separator-free identifier folds to the
literal `'other'`:

[`src/shared/services/telemetry.ts:50`](../src/shared/services/telemetry.ts#L50)

```ts
export function safeComponentType(componentType: string): string {
  return typeof componentType === 'string' &&
    componentType.length <= MAX_COMPONENT_TYPE_LENGTH &&
    COMPONENT_TYPE_SHAPE.test(componentType)
    ? componentType
    : 'other';
}
```

**Enforcing code — the two documented exceptions.** They are called out in the `emitTelemetry` doc so
no one adds a third by accident:

[`src/shared/services/telemetry.ts:103`](../src/shared/services/telemetry.ts#L103)

```ts
 * @param attributes - flat map of SAFE primitives only (counts, durationMs, booleans, type names,
 * structured error codes, lifecycle states). Two deliberate exceptions (Jun 2026 decision): an
 * `errorMessage` on error-path events, and `componentName`/error reason on the
 * DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE sub-event. Everything else stays bounded — never pass
 * component names, paths, or dataspace names on any other event.
```

The `errorMessage` exception is intentionally **not** bounded (raw mapped `SfError` message allowed on
failure events, correlated by `orgId`), and it is only attached on error paths
([telemetry.ts:79](../src/shared/services/telemetry.ts#L79)). `safeOrgId` emits only a non-PII org id,
and omits it entirely when unavailable rather than emitting a placeholder
([telemetry.ts:65](../src/shared/services/telemetry.ts#L65)).

**Why.** Telemetry is uploaded off-box and aggregated; a customer's component names, dataspace names,
and file paths are potentially sensitive and have no place in an aggregate metrics store. Encoding the
rule in the **type** (flat primitives) means a well-meaning contributor cannot accidentally attach a
raw API body — the compiler stops them. The two exceptions exist because production debugging of
failures needs the error text and the specific failing component; they are deliberate, reviewed, and
confined to failure events.

> **Note (code vs. docs).** `CLAUDE.md` says telemetry goes to Splunk. In reality CLI telemetry flows
> through the sf CLI infrastructure to **Azure App Insights** (see the module header at
> [telemetry.ts:20](../src/shared/services/telemetry.ts#L20) and the `MEMORY.md` note). The local
> diagnostic NDJSON uses the same field names so an engineer can grep locally with the names they see
> in App Insights.

> Full event catalog, attribute-by-attribute privacy classification, and the failure sub-event:
> [`docs/TELEMETRY.md`](./TELEMETRY.md).

---

## 8. Redaction as a Security Boundary

**Rule.** Every value written to a diagnostic file passes through redaction first, at **all** log
levels. Redaction runs two passes — **key-based** (a value under a credential-named key is dropped
wholesale) and **value-pattern** (known secret shapes are masked in place) — and it is **fail-closed**:
any error during traversal collapses the whole value to `REDACTED_ERROR` rather than risk a leak.

**Enforcing code — fail-closed entry point.** This is the only redaction API callers use; on any
internal failure it returns the sentinel instead of the raw value:

[`src/shared/diagnostics/redact.ts:162`](../src/shared/diagnostics/redact.ts#L162)

```ts
export function redact(value: unknown): unknown {
  try {
    return redactInner(value, new WeakSet<object>(), 0);
  } catch {
    return REDACTED_ERROR;
  }
}
```

**Enforcing code — key-based drop.** During traversal, a secret-named key's value is replaced before
it is ever inspected:

[`src/shared/diagnostics/redact.ts:150`](../src/shared/diagnostics/redact.ts#L150)

```ts
const out: Record<string, unknown> = {};
for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
  out[key] = isSecretKey(key) ? REDACTED : redactInner(val, seen, depth + 1);
}
return out;
```

`isSecretKey` matches a normalized key set (`authorization`, `token`, `sessionid`, `refreshtoken`,
`xsfdcsession`, …) and also the `x`-stripped form so custom headers like `X-Auth-Token` are caught
([redact.ts:84](../src/shared/diagnostics/redact.ts#L84)). The value patterns cover Bearer headers,
JWTs, Salesforce session ids, and refresh-token prefixes, and are **ReDoS-safe** — the one lookbehind
bounds its separator run to `{1,4}` (an earlier unbounded form was measured at 428ms on a 16KiB
adversarial input) ([redact.ts:96](../src/shared/diagnostics/redact.ts#L96)). Traversal is depth- and
cycle-bounded; over the limit it over-redacts to `REDACTED` rather than recurse
([redact.ts:141](../src/shared/diagnostics/redact.ts#L141)).

**Why.** The local diagnostic file is written to the developer's disk and is routinely attached to
support cases or `datacloud diagnostics` bundles — it must never carry a live token. "Fail-closed"
means a bug in the redactor degrades to over-redaction (useless-but-safe), never under-redaction
(a leak). Both passes exist because neither is sufficient alone: a key can be misnamed, and a secret
can be embedded in free text. The ReDoS bound is a real availability control, not a micro-optimization.

> Level tiers, what reaches `extra` at DEBUG/TRACE, and the redaction test matrix:
> [`docs/DIAGNOSTICS.md`](./DIAGNOSTICS.md).

---

## 9. Correlation ID Threading

**Rule.** Every real operation mints one correlation id (a UUID), and that single id is: **emitted in
telemetry**, **stamped on every diagnostic row** for the operation, and — once the backend header
contract is confirmed — **sent as a request header** so CLI, Connect API, and DataKit logs join on one
id. The two channels reuse the _same_ id for one operation.

**Enforcing code — mint once, reuse everywhere.** The deploy orchestrator mints the id and binds both
the diagnostic child logger and the telemetry event to it:

[`src/shared/services/deploy-service.ts:99`](../src/shared/services/deploy-service.ts#L99)

```ts
const correlationId = randomUUID();
// Local diagnostic channel (passive observer, separate from telemetry). Reuse the orchestrator's
// correlationId so the on-disk logs join to the telemetry events by one id.
const diag = getDiagLogger().begin({ command: 'data-cloud deploy', correlationId });
```

The same `correlationId` is passed down into the HTTP layer (`createPromotion(conn, request,
correlationId)`, [deploy-service.ts:134](../src/shared/services/deploy-service.ts#L134)) and attached
to the telemetry event ([deploy-service.ts:147](../src/shared/services/deploy-service.ts#L147)).

**Enforcing code — the header, gated off until confirmed.** The header name is a placeholder and the
gate ships `false`, so no unrecognized header is sent; flipping the flag + setting the real name is the
only remaining step:

[`src/shared/services/devops-api.ts:57`](../src/shared/services/devops-api.ts#L57)

```ts
export const CORRELATION_ID_HEADER = 'x-correlation-id';
const SEND_CORRELATION_HEADER: boolean = false;
```

```ts
export const correlationHeaders = (
  correlationId: string,
  enabled: boolean = SEND_CORRELATION_HEADER
): Record<string, string> => (enabled ? { [CORRELATION_ID_HEADER]: correlationId } : {});
```

The type annotation `: boolean` (not the literal `false`) is intentional — it keeps the gate a real
runtime check rather than dead code the `no-unnecessary-condition` lint would strip.

**Why.** A DevOps operation crosses three teams' systems (CLI → Connect API → DataKit). When something
fails, one shared id turns three disconnected log searches into one traceable thread. Reusing the id
across telemetry and diagnostics lets an engineer pivot from an aggregate App Insights event straight
to the rich local NDJSON for that exact run. The header is deliberately gated off because sending a
header the backend does not read is worse than useless — the code is ready, the contract is not.

> **Note (code vs. docs).** `SEND_CORRELATION_HEADER` currently ships `false`; the header name is a
> placeholder pending backend confirmation. Related: gack-id extraction is likewise disabled
> (`GACK_EXTRACTION_ENABLED = false`, [telemetry.ts:94](../src/shared/services/telemetry.ts#L94))
> because it is unverified whether `/ssot/devops/*` errors surface a gack id.

---

## 10. No Side Effects at Import

**Rule.** Importing the diagnostics modules does **nothing** — no filesystem access, no network, no
env reads that matter, no logger construction. Config, log directory, plugin version, and the file
handle all resolve on **first use**, then cache. When the channel is disabled, first use returns a
no-op that opens no file and allocates nothing per call.

**Enforcing code — lazy singleton.** The logger is built the first time `getDiagLogger()` is _called_,
never at module load; a disabled channel gets a no-op instance whose `sink` is `undefined`:

[`src/shared/diagnostics/logger.ts:238`](../src/shared/diagnostics/logger.ts#L238)

```ts
export function getDiagLogger(): DiagLogger {
  if (singleton !== undefined) {
    return singleton;
  }
  const config = resolveDiagConfig();
  if (!config.anyEnabled) {
    singleton = new DiagLogger(undefined, DEFAULT_COMMAND, 'disabled');
    return singleton;
  }
  // Per-process default correlation id; begin({ correlationId }) overrides it for a bound child.
  singleton = new DiagLogger(new FileSink(config), DEFAULT_COMMAND, randomUUID());
  return singleton;
}
```

**Enforcing code — config resolution is pure.** `resolveDiagConfig` reads env through `@salesforce/kit`
but touches no filesystem; the on-disk directory is resolved separately, inside `FileSink`'s
constructor, which only runs on the enabled path:

[`src/shared/diagnostics/config.ts:73`](../src/shared/diagnostics/config.ts#L73)

```ts
export function resolveDiagConfig(env: Env = new Env()): DiagConfig {
  const globalLevel = parseLevel(env.getString(GLOBAL_VAR)) ?? DEFAULT_LEVEL;
  ...
```

The module header states this as an invariant: "config/dir/version/file are resolved on first use,
then cached … importing this module is always free of side effects"
([logger.ts:33](../src/shared/diagnostics/logger.ts#L33),
[event.ts:17](../src/shared/diagnostics/event.ts#L17)).

**Why.** oclif loads command modules eagerly to build help and the command index — and every command
transitively imports the diagnostics stack. If importing the logger created a directory, opened a
file, or hit the network, then merely running `sf --help` (or a completely unrelated command) would
have side effects and pay that cost. Lazy resolution keeps import free, makes the disabled path
allocation-free, and makes the modules trivially unit-testable (hand `resolveDiagConfig` a throwaway
`Env`). `resetDiagLoggerForTest()` exists solely to drop the cached singleton between tests.

---

## 11. Separation of Channels

**Rule.** The two observability channels are **independent** and never share a code path. **Telemetry**
emits bounded, flat primitives on the sf CLI Lifecycle channel → App Insights, for aggregate metrics.
**Diagnostics** writes rich, nested, redacted NDJSON to a local rotating file, for debugging a single
run. Diagnostics never routes through `emitTelemetry`, and telemetry never writes to disk.

**Enforcing code — they are separate modules with separate shapes.** Telemetry's payload is a flat
primitive map (Principle 7, [telemetry.ts:34](../src/shared/services/telemetry.ts#L34)). Diagnostics'
payload is a nested NDJSON row that explicitly carries a free-form, deep-redacted `extra` bag —
something telemetry structurally cannot:

[`src/shared/diagnostics/event.ts:93`](../src/shared/diagnostics/event.ts#L93)

```ts
export type DiagEvent = {
  ts: string;
  level: string;
  correlation_id: string;
  pid: number;
  command: string;
  plugin_version: string;
  msg: string;
  code?: string;
  subsystem?: string;
  duration_ms?: number;
  extra?: Record<string, unknown>;
  error?: DiagError;
};
```

**Enforcing code — a service uses both, side by side, without crossing them.** In `getComponents`,
telemetry and diagnostics are emitted from the same block but through their own APIs — the diagnostic
call never goes through `emitTelemetry` and vice versa:

[`src/shared/services/devops-api.ts:224`](../src/shared/services/devops-api.ts#L224)

```ts
void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
  correlationId,
  operation: 'components',
  componentType: safeComponentType(componentType),
  ...(orgId && { orgId }),
  success: true,
  resultCount: resp.components.length,
  durationMs: Date.now() - startedAt,
});
diag.debug(Subsystem.API, 'API_REQ_END', 'components received', {
  operation: 'components',
  component_type: safeComponentType(componentType),
  result_count: resp.components.length,
  ...
```

Note the deliberate casing split: telemetry attributes are `camelCase`; diagnostic `extra` keys are
`snake_case` (a stable on-disk log-ingest schema matching the remote field names, hence the
`/* eslint-disable camelcase */` in the service files, e.g.
[devops-api.ts:34](../src/shared/services/devops-api.ts#L34)). The module header on `event.ts` states
the invariant outright: "The two channels never share code paths and diagnostics never routes through
emitTelemetry()" ([event.ts:17](../src/shared/diagnostics/event.ts#L17)).

**Why.** The channels have opposite constraints. Telemetry must be tiny, PII-free, and aggregatable;
diagnostics must be rich, local, and per-run. Fusing them would force one channel to inherit the
other's limits — either diagnostics would lose its nested `extra`, or telemetry would risk carrying
unbounded local detail off-box. Keeping them as two APIs with two shapes lets each be exactly what it
needs to be, while a shared correlation id (Principle 9) still stitches them together after the fact.

---

## 12. Runtime Extensibility Over Catalogs

**Rule.** New backend component types must get correct on-disk folder names with **zero CLI changes**.
Folder names are computed by algorithm — `toKebabCase` + `pluralize` — not looked up in a hardcoded
type→folder catalog. Every type flows through the identical derivation, with no per-type overrides.

**Enforcing code.** The two pure functions that make new types "just work":

[`src/shared/constants/component-paths.ts:38`](../src/shared/constants/component-paths.ts#L38)

```ts
export function toKebabCase(input: string): string {
  return String(input)
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // lower/digit → Upper boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // acronym run → Word boundary (run this order)
    .replace(/([A-Za-z])([0-9])/g, '$1 $2') // letter → digit boundary
    .replace(/([0-9])([A-Za-z])/g, '$1 $2') // digit → letter boundary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any non-alnum run (incl. path separators) → single hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens (kills leading '..', '/')
}
```

[`src/shared/constants/component-paths.ts:55`](../src/shared/constants/component-paths.ts#L55)

```ts
export function pluralize(kebab: string): string {
  const parts = kebab.split('-');
  const last = parts[parts.length - 1];
  if (last === '' || last.endsWith('s')) {
    return kebab;
  }
  if (/(sh|ch|x|z)$/.test(last)) {
    parts[parts.length - 1] = `${last}es`;
  } else if (/[^aeiou]y$/.test(last)) {
    parts[parts.length - 1] = `${last.slice(0, -1)}ies`;
  } else {
    parts[parts.length - 1] = `${last}s`;
  }
  return parts.join('-');
}
```

So `CalculatedInsight → calculated-insights`, `DataModelObject → data-model-objects`, and a
hypothetical new `DataMesh → data-meshes` — with no code edit. The module header states the intent:
folder names are derived "rather than looked up in a hardcoded catalog, so a new backend component
type gets a correct folder with ZERO CLI changes"
([component-paths.ts:20](../src/shared/constants/component-paths.ts#L20)). The one genuinely special
routing rule — dataspace-agnostic types living at the root — is itself a small extensible `Set`, not a
per-type branch ([component-paths.ts:93](../src/shared/constants/component-paths.ts#L93)).

**Why.** Data Cloud has 30+ component types and the list grows on the backend's schedule, not the
CLI's. A hardcoded catalog would mean every new backend type required a CLI release just to place its
files — coupling two teams' deploy cycles and guaranteeing drift. The code is written generically for
all types even though only CalculatedInsight + its DMO dependencies must work end-to-end this sprint;
the algorithmic derivation is what makes that generality real rather than aspirational.

> The kebab/plural rules, root-routing, and worked examples: [`docs/ON_DISK_FORMAT.md`](./ON_DISK_FORMAT.md).

---

## 13. Conventional Commits + Modular Structure

**Rule.** Commits use Conventional Commit prefixes (`feat:`, `fix:`, `chore:`, `test:`, `refactor:`),
and the code is modular with a strict dependency direction: **commands depend on services; services
never import commands; commands never import each other.** One concern per file.

**Enforcing evidence — commit history.** The recent log follows the convention, e.g. `refactor(paths):
derive component folders at runtime…`, `fix(tests): handle Windows path separators…`,
`feat(diagnostics): add data-cloud diagnostics command…`, `feat(deploy): wire deploy status to real
promotion-status API`.

**Enforcing code — the dependency direction.** A command imports **only** from `shared/services` and
`shared/types` — never another command:

[`src/commands/data-cloud/deploy/index.ts:17`](../src/commands/data-cloud/deploy/index.ts#L17)

```ts
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { deployComponents } from '../../../shared/services/deploy-service.js';
import { DeployResult } from '../../../shared/types/deploy.js';
```

Services depend downward on other services, the HTTP boundary, types, and diagnostics — but never on a
command:

[`src/shared/services/deploy-service.ts:19`](../src/shared/services/deploy-service.ts#L19)

```ts
import { DeployResult, DeployApiRequest, DeployApiResponse, DeploymentLifecycleStatus } from '../types/deploy.js';
import { ComponentFile } from '../types/file-layout.js';
import { getDiagLogger } from '../diagnostics/logger.js';
import { Subsystem } from '../diagnostics/event.js';
import { readComponentFile, collectTransitiveDependencies } from './file-reader.js';
import { createPromotion } from './devops-api.js';
import { emitTelemetry, safeComponentType, safeOrgId, errorMessageFrom, extractGackId } from './telemetry.js';
```

Note also the ESM `.js` import extensions (this is a `"type": "module"` package) and the small,
single-responsibility service files (path derivation in `constants/component-paths.ts`, HTTP in
`devops-api.ts`, orchestration in `deploy-service.ts`, file I/O in `file-writer.ts`).

**Why.** Conventional Commits make the history machine-readable (changelogs, release tooling) and
tell a reviewer the _kind_ of change at a glance. The one-directional dependency graph
(command → service → HTTP/types) is what keeps commands thin (Principle 1) and services reusable
across future surfaces (MCP, Agentforce): a service has no idea it is being called from a CLI command,
so it can be called from anywhere. Commands importing each other would create cycles and couple
unrelated features; that is why it does not happen.

---

## Appendix A: Code-vs-docs discrepancies

Where the code (the source of truth) diverges from `CLAUDE.md` / `PROJECT_KNOWLEDGE.md`, follow the
code. Each item below is flagged in-context above.

| #   | Topic              | `CLAUDE.md` / planning says                                                    | Code says (authoritative)                                                                                    | Where                                                                   |
| --- | ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 1   | Endpoint paths     | `/retrieve`, `/deploy`, `/deploy/{jobId}/status`, `component-object-api-names` | `component/snapshot`, `component/promotion`, `component/promotion/{jobId}`, `component/catalog`              | [devops-api.ts:147+](../src/shared/services/devops-api.ts#L147)         |
| 2   | Telemetry sink     | Splunk                                                                         | Azure App Insights (via sf CLI infra)                                                                        | [telemetry.ts:20](../src/shared/services/telemetry.ts#L20)              |
| 3   | Correlation header | Sent CLI → Connect API                                                         | Gated **off** (`SEND_CORRELATION_HEADER = false`); header name is a placeholder pending backend confirmation | [devops-api.ts:57](../src/shared/services/devops-api.ts#L57)            |
| 4   | Gack-id extraction | Implied available                                                              | Ships **disabled** (`GACK_EXTRACTION_ENABLED = false`); unverified that `/ssot/devops/*` surfaces a gack id  | [telemetry.ts:94](../src/shared/services/telemetry.ts#L94)              |
| 5   | Command count      | "The five commands"                                                            | **Six** `data-cloud` commands exist (adds `data-cloud diagnostics`)                                          | `src/commands/data-cloud/`                                              |
| 6   | Folder derivation  | Earlier planning implied a type→folder catalog                                 | Catalog **removed** (commit `47ae970`); folders derived at runtime                                           | [component-paths.ts:78](../src/shared/constants/component-paths.ts#L78) |

**Open questions to confirm before acting (from `PROJECT_KNOWLEDGE.md` Appendix / code TODOs):** the
final CLI namespace (`data-cloud` vs `d360`/`D3`), the real correlation header name, and whether the
DevOps endpoints surface a gack id. Do not resolve these by guessing — confirm with the backend owner.
