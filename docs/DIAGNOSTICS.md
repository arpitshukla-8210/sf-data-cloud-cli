# Local Diagnostics

> **Audience:** engineers and support staff working on `@salesforce/plugin-datacloud-devops`.
> **Scope:** the plugin's **local, on-disk diagnostic-logging channel** — how it is configured, what
> it writes, how it protects secrets, how it bounds disk usage, and how the `sf data-cloud
diagnostics` command packages those logs for support.
>
> This document is self-contained: you do not need any prior context about the plugin to read it.
> Where useful it links to sibling docs:
> [TELEMETRY.md](TELEMETRY.md) (the remote metrics channel) and
> [DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) (the cross-cutting invariants).

## Scope and ownership (read this first)

This plugin is a **thin CLI client**. It owns two layers:

1. **Layer 1 — the CLI itself** (oclif commands and the TypeScript services behind them). The
   diagnostics channel documented here lives entirely in Layer 1.
2. **Layer 2 — the Connect API _contracts_** (the request/response representation types the CLI
   sends and receives).

It does **not** own the Connect API _implementation_, the server-side spidering, or the DataKit
Orchestration Layer (Layer 3). Consequently the diagnostic logs **never contain, and must never
contain, DataKit internals** — no DataKit names, template names, or encoded XML. Diagnostics observe
what the CLI does (which endpoint it called, how long it took, how many components came back), not
how the server fulfilled the request.

Everything below is derived from the source. Where the code differs from a design note in
[CLAUDE.md](../CLAUDE.md) or `PROJECT_KNOWLEDGE.md`, **the code is authoritative** and the discrepancy
is flagged inline with a **⚠ Code vs. docs** callout.

---

## 1. Two channels: telemetry vs. diagnostics

The plugin has **two independent observability channels**. They deliberately share no code path.

|             | **Telemetry**                                                          | **Diagnostics** (this doc)                                                 |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Purpose     | Aggregate metrics across all users                                     | Rich detail for debugging **one** invocation                               |
| Destination | Remote (Azure App Insights, via the CLI's Lifecycle telemetry channel) | **Local** file on disk — no network egress                                 |
| Shape       | Flat, bounded primitives                                               | Nested, free-form NDJSON rows with an `extra` bag                          |
| Volume      | One-ish event per command                                              | Many rows per command (INFO by default, DEBUG/TRACE opt-in)                |
| Retention   | Server-side                                                            | Local, rotated/pruned (see [§8](#8-storage-directories-rotation-and-gzip)) |
| PII posture | Never carries raw names/paths                                          | Carries raw names/paths **only at DEBUG/TRACE**, always redacted           |
| Entry point | `emitTelemetry()`                                                      | `getDiagLogger()`                                                          |

The header comment in [event.ts:17-25](../src/shared/diagnostics/event.ts#L17-L25) states the
relationship precisely:

> This is a SECOND, independent observability channel that sits alongside — never inside —
> telemetry.ts: it writes richer, nested, correlatable NDJSON to a rotating on-disk file for
> debugging a single run, whereas telemetry emits bounded flat primitives to App Insights for
> aggregate metrics. [...] The two channels never share code paths and diagnostics never routes
> through `emitTelemetry()`.

**Why two channels?** Telemetry answers "how often does deploy fail across the fleet?" It must be
cheap, bounded, and privacy-safe, so it carries only flat primitives. Diagnostics answers "why did
_this_ deploy on _this_ machine fail?" That needs correlatable, nested context — which is exactly
what you cannot ship to a shared metrics backend. Keeping them separate lets each be optimized for
its job without one compromising the other.

> ⚠ **Code vs. docs.** [CLAUDE.md](../CLAUDE.md) lists "structured logs → Splunk" under Observability.
> That does **not** describe this channel: diagnostics is **local-file-only with no forwarder** —
> nothing ships these logs anywhere automatically. The `sf data-cloud diagnostics` command is the
> only way logs leave the machine, and only when a human runs it. (Remote telemetry lands in Azure
> App Insights, not Splunk; see [TELEMETRY.md](TELEMETRY.md).)

---

## 2. Architecture: the write pipeline

The channel is split into small, single-purpose modules. Data flows left-to-right on each log call;
the pieces on the right are pulled in lazily and only when the channel is enabled.

```
                         getDiagLogger()  ──▶  DiagLogger (singleton)
                                                     │  .begin({command, correlationId})
                                                     ▼
  logger call:  log.info(Subsystem.API, 'API_REQ_OK', 'retrieved', { count: 12 })
                                                     │
   ┌─────────────┐   ┌──────────────┐   ┌────────────▼────────────┐   ┌──────────────┐   ┌────────────┐
   │  event.ts   │   │   config.ts  │   │        logger.ts        │   │   redact.ts  │   │ storage.ts │
   │ types/enums │   │ env → levels │   │  DiagLogger + FileSink  │   │  scrub secr. │   │ dir + rot. │
   │ DiagEvent,  │──▶│ resolveDiag- │──▶│  level-gate → build row │──▶│ redact(),    │──▶│ resolveLog-│
   │ LogLevel,   │   │  Config(),   │   │  → JSON.stringify → \n  │   │ redactString │   │ Dir(), log-│
   │ Subsystem   │   │ levelFor()   │   │  → sink.append()        │   │ (fail-closed)│   │ FileName(),│
   └─────────────┘   └──────────────┘   └────────────┬────────────┘   └──────────────┘   │ ROTATION,  │
         ▲                    ▲                       │                                    │ maintain-  │
         │                    │                       │  plugin_version stamped from       │ LogDir()   │
         │  plugin-version.ts │                       │                                    └────────────┘
         └────────────────────┴───── getPluginVersion() (memoized) ◀────────────────────────────┘

  bundle command (separate, on-demand):
   sf data-cloud diagnostics ─▶ diagnostics-service.ts (collectDiagnosticBundle)
                                    reads logs/ ─▶ tar-writer.ts (USTAR) ─▶ gzipSync ─▶ *.tar.gz
```

Module responsibilities:

| Module                                                                  | Responsibility                                                                                                                      | Key exports                                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [event.ts](../src/shared/diagnostics/event.ts)                          | Pure vocabulary: the `DiagEvent` row schema, `LogLevel`, `Subsystem`, level-name maps. Zero side effects at import.                 | `LogLevel`, `Subsystem`, `DiagEvent`, `DiagError`, `DEFAULT_LEVEL`, `LEVEL_NAME`, `NAME_LEVEL` |
| [config.ts](../src/shared/diagnostics/config.ts)                        | Reads env vars (via `@salesforce/kit`'s `Env`) and computes the effective level per subsystem. Pure — never touches the filesystem. | `resolveDiagConfig()`, `parseLevel()`, `DiagConfig`                                            |
| [logger.ts](../src/shared/diagnostics/logger.ts)                        | The passive-observer logger: singleton + `begin()` children, level gating, row assembly, best-effort append.                        | `getDiagLogger()`, `DiagLogger`, `resetDiagLoggerForTest()`                                    |
| [storage.ts](../src/shared/diagnostics/storage.ts)                      | Where files live (per-OS), deterministic file names, rotation/retention/gzip housekeeping, home-path scrubbing.                     | `resolveLogDir()`, `logFileName()`, `ROTATION`, `maintainLogDir()`, `homeScrub()`              |
| [redact.ts](../src/shared/diagnostics/redact.ts)                        | Deep, fail-closed secret redaction (key-based + value-pattern).                                                                     | `redact()`, `redactString()`, `isSecretKey()`, `REDACTED`, `REDACTED_ERROR`                    |
| [plugin-version.ts](../src/shared/diagnostics/plugin-version.ts)        | Memoized lazy resolver for `plugin_version`.                                                                                        | `getPluginVersion()`, `resetPluginVersionForTest()`                                            |
| [tar-writer.ts](../src/shared/diagnostics/tar-writer.ts)                | Hand-rolled write-only USTAR tar encoder (Node ships gzip but no tar).                                                              | `tarball()`, `TarEntry`                                                                        |
| [diagnostics-service.ts](../src/shared/services/diagnostics-service.ts) | The bundle builder for the `diagnostics` command: collect logs → manifest → env → tar → gzip.                                       | `collectDiagnosticBundle()`, `buildEnvironmentInfo()`, `MAX_BUNDLE_BYTES`                      |
| [types/diagnostics.ts](../src/shared/types/diagnostics.ts)              | Bundle artifact types + the environment allowlist.                                                                                  | `SAFE_ENV_ALLOWLIST`, `DiagnosticsManifest`, `DiagnosticsResult`                               |

The design invariants this split enforces — never throws, never blocks, no side effects at import,
cheap when off, bounded on disk — are spelled out in
[logger.ts:25-39](../src/shared/diagnostics/logger.ts#L25-L39). See
[DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) for the project-wide framing.

---

## 3. Configuration (environment variables)

All configuration is via environment variables, read once per process through `@salesforce/kit`'s
`Env` (never raw `process.env`, so it matches how the rest of the plugin reads config). There is no
config file and no CLI flag for verbosity — you set an env var, then reproduce your issue.

| Variable                        | Effect                                                                                                   | Default                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `SF_DATACLOUD_LOG_LEVEL`        | Global verbosity for all subsystems. One of `OFF`, `ERROR`, `INFO`, `DEBUG`, `TRACE` (case-insensitive). | `INFO`                                                                |
| `SF_DATACLOUD_LOG_LEVEL_API`    | Override the level for the `API` subsystem only.                                                         | inherits global                                                       |
| `SF_DATACLOUD_LOG_LEVEL_DEPLOY` | Override the level for the `DEPLOY` subsystem only.                                                      | inherits global                                                       |
| `SF_DATACLOUD_LOG_LEVEL_FILEIO` | Override the level for the `FILEIO` subsystem only.                                                      | inherits global                                                       |
| `SF_DATACLOUD_LOG_DIR`          | Override the platform-default directory logs are written to. Empty/whitespace is treated as unset.       | platform default (see [§8](#8-storage-directories-rotation-and-gzip)) |

Notes that follow directly from the code:

- **INFO is on by default.** With nothing set, every command writes bounded INFO NDJSON — this is a
  confirmed product decision, noted at [event.ts:27-31](../src/shared/diagnostics/event.ts#L27-L31).
  Set `SF_DATACLOUD_LOG_LEVEL=OFF` to disable the channel entirely (the logger short-circuits to a
  no-op that opens no file).
- **There is no `_CORE` override.** The `CORE` subsystem always follows the global level — its entry
  in the subsystem map is the empty string ([config.ts:41-42](../src/shared/diagnostics/config.ts#L41-L42)).
  > ⚠ **Code vs. docs.** Only three per-subsystem overrides exist (`API`, `DEPLOY`, `FILEIO`);
  > `CORE` has no dedicated variable by design.
- **A typo never breaks logging.** `parseLevel` returns `undefined` for an unknown name, and the
  caller falls back to the default (global) or to inheriting the global (a subsystem override) — an
  invalid value never throws and never silently disables logging.

The per-subsystem variable map ([config.ts:37-43](../src/shared/diagnostics/config.ts#L37-L43)):

```ts
const GLOBAL_VAR = 'SF_DATACLOUD_LOG_LEVEL';
const DIR_VAR = 'SF_DATACLOUD_LOG_DIR';
const SUBSYSTEM_VAR: Readonly<Record<Subsystem, string>> = {
  [Subsystem.API]: 'SF_DATACLOUD_LOG_LEVEL_API',
  [Subsystem.DEPLOY]: 'SF_DATACLOUD_LOG_LEVEL_DEPLOY',
  [Subsystem.FILEIO]: 'SF_DATACLOUD_LOG_LEVEL_FILEIO',
  // CORE has no dedicated override — it always follows the global level.
  [Subsystem.CORE]: '',
};
```

The level parser ([config.ts:51-55](../src/shared/diagnostics/config.ts#L51-L55)):

```ts
export function parseLevel(raw?: string): LogLevel | undefined {
  if (!raw) return undefined;
  const level = NAME_LEVEL[raw.trim().toUpperCase()];
  return level; // undefined when not a known name.
}
```

And the resolution that combines them ([config.ts:73-97](../src/shared/diagnostics/config.ts#L73-L97)):

```ts
export function resolveDiagConfig(env: Env = new Env()): DiagConfig {
  const globalLevel = parseLevel(env.getString(GLOBAL_VAR)) ?? DEFAULT_LEVEL;

  const overrides = new Map<Subsystem, LogLevel>();
  for (const subsystem of Object.values(Subsystem)) {
    const varName = SUBSYSTEM_VAR[subsystem];
    const override = varName ? parseLevel(env.getString(varName)) : undefined;
    if (override !== undefined) {
      overrides.set(subsystem, override);
    }
  }

  const levelFor = (subsystem: Subsystem): LogLevel => overrides.get(subsystem) ?? globalLevel;

  const anyEnabled = globalLevel > LogLevel.OFF || [...overrides.values()].some((level) => level > LogLevel.OFF);

  const trimmedDir = env.getString(DIR_VAR)?.trim();
  const logDirOverride = trimmedDir ? trimmedDir : undefined;

  return { globalLevel, levelFor, logDirOverride, anyEnabled };
}
```

`anyEnabled` is the fast top-level gate: if every effective level is `OFF`, `getDiagLogger()` hands
back a no-op logger that allocates nothing per call.

**Examples**

```bash
# Turn everything up to TRACE while reproducing a bug:
SF_DATACLOUD_LOG_LEVEL=TRACE sf data-cloud deploy --source-dir ./data-cloud

# Only crank the DEPLOY subsystem; leave the rest at the INFO default:
SF_DATACLOUD_LOG_LEVEL_DEPLOY=DEBUG sf data-cloud deploy --source-dir ./data-cloud

# Disable diagnostics entirely for one run:
SF_DATACLOUD_LOG_LEVEL=OFF sf data-cloud retrieve --metadata CalculatedInsight:MyCI

# Write logs somewhere else (e.g. a scratch dir you can inspect):
SF_DATACLOUD_LOG_DIR=/tmp/dc-logs sf data-cloud deploy --source-dir ./data-cloud
```

---

## 4. The NDJSON row schema (`DiagEvent`)

Each log file is **NDJSON** — one JSON object per line. Each line is a `DiagEvent`
([event.ts:93-118](../src/shared/diagnostics/event.ts#L93-L118)). Field names are **`snake_case` by
design**: this is a stable on-disk / log-ingest contract that matches the remote telemetry field
names, so the same grep works across both channels
([logger.ts:187-190](../src/shared/diagnostics/logger.ts#L187-L190)).

| Field            | Type   | Required | Meaning                                                                                                                       |
| ---------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ts`             | string | ✅       | ISO-8601 UTC timestamp, minted at write time.                                                                                 |
| `level`          | string | ✅       | Uppercase level name: `ERROR` / `INFO` / `DEBUG` / `TRACE`.                                                                   |
| `correlation_id` | string | ✅       | Per-invocation correlation id; reuses the orchestrator's `correlationId` when bound via `begin()`.                            |
| `pid`            | number | ✅       | Process id — disambiguates concurrent invocations sharing one log directory.                                                  |
| `command`        | string | ✅       | Command slug, e.g. `data-cloud deploy`; defaults to `data-cloud` when unbound.                                                |
| `plugin_version` | string | ✅       | The plugin's `package.json` version, or `unknown` if unreadable (see [§10](#10-the-plugin-version-resolver)).                 |
| `msg`            | string | ✅       | Human-readable one-line description. Always passed through `redactString`.                                                    |
| `code`           | string | optional | Machine-parseable event code, e.g. `CMD_START`, `API_REQ_ERR`.                                                                |
| `subsystem`      | string | optional | `API` / `DEPLOY` / `FILEIO` / `CORE` (see [§5](#5-subsystem-taxonomy)).                                                       |
| `duration_ms`    | number | optional | Elapsed wall-clock for a completed phase, in ms. Lifted out of the `extra` bag; written only when it is a finite number.      |
| `extra`          | object | optional | Free-form, **deep-redacted** context bag (counts, statuses, and — at DEBUG/TRACE — names/paths). Written only when non-empty. |
| `error`          | object | optional | Structured error detail (`DiagError`), attached on error events.                                                              |

The `DiagError` sub-shape ([event.ts:80-85](../src/shared/diagnostics/event.ts#L80-L85)):

| Field     | Type    | Meaning                                                                       |
| --------- | ------- | ----------------------------------------------------------------------------- |
| `name`    | string? | The error's `name`.                                                           |
| `code`    | string? | The `SfError` `code` (e.g. `DataCloudApiAuthError`), when present.            |
| `message` | string? | The error message — included for debugging, but redacted before it hits disk. |

**How a row is assembled.** `buildEvent` ([logger.ts:179-214](../src/shared/diagnostics/logger.ts#L179-L214))
destructures `duration_ms` and `err` out of the caller-supplied `extra`, redacts `msg`, sets
`duration_ms` only when it is a finite number, attaches `error` via `toDiagError` when an `err` was
passed, and attaches the redacted remainder of `extra` only when it is non-empty. The `error` field
is populated from an `err` key inside `extra`, converted by
[`toDiagError`](../src/shared/diagnostics/logger.ts#L218-L228).

**Example NDJSON lines** (pretty-printed here for readability; on disk each is a single line):

```json
{
  "ts": "2026-07-13T18:22:01.481Z",
  "level": "INFO",
  "correlation_id": "7f3c1a2e-...",
  "pid": 48213,
  "command": "data-cloud deploy",
  "plugin_version": "1.0.0",
  "msg": "deploy submitted",
  "code": "DEPLOY_SUBMITTED",
  "subsystem": "DEPLOY",
  "extra": { "component_count": 4, "job_id": "3Pg...", "status": "Submitted" }
}
```

```json
{
  "ts": "2026-07-13T18:22:02.905Z",
  "level": "ERROR",
  "correlation_id": "7f3c1a2e-...",
  "pid": 48213,
  "command": "data-cloud deploy",
  "plugin_version": "1.0.0",
  "msg": "promotion status request failed",
  "code": "API_REQ_ERR",
  "subsystem": "API",
  "duration_ms": 812,
  "error": { "name": "SfError", "code": "DataCloudApiError", "message": "request failed" }
}
```

To emit these, a service calls (with `err` and `duration_ms` living inside the `extra` bag):

```ts
const log = getDiagLogger().begin({ command: 'data-cloud deploy', correlationId });
log.info(Subsystem.DEPLOY, 'DEPLOY_SUBMITTED', 'deploy submitted', {
  component_count: 4,
  job_id: jobId,
  status: 'Submitted',
});
log.error(Subsystem.API, 'API_REQ_ERR', 'promotion status request failed', {
  duration_ms: 812,
  err,
});
```

> The event **codes** (`CMD_START`, `API_REQ_ERR`, `DEPLOY_SUBMITTED`, …) are free-form strings
> chosen by each caller; `event.ts` documents them as examples, not a closed enum. Use existing
> codes where they fit; keep new ones `UPPER_SNAKE`.

---

## 5. Subsystem taxonomy

Every event names a coarse `Subsystem` ([event.ts:47-52](../src/shared/diagnostics/event.ts#L47-L52)),
which both tags the row and selects the verbosity override that applies to it. There are exactly
four:

| Subsystem | Covers                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API`     | Outbound Connect API interaction — the `/ssot/devops/*` request/response round-trips (component-type/component listing, retrieve, deploy, deploy-status). Timings, status codes, request/response shape at DEBUG/TRACE. |
| `DEPLOY`  | The deploy/promotion workflow orchestration in the CLI: submission, job id, polling, terminal status.                                                                                                                   |
| `FILEIO`  | Local disk work — reading a source tree, writing the deterministic per-component files, manifest handling.                                                                                                              |
| `CORE`    | The catch-all for logger/lifecycle events that belong to no single subsystem. Always follows the global level (no dedicated override — see [§3](#3-configuration-environment-variables)).                               |

The value each subsystem gives you is **targeted verbosity**: you can crank `API` to `TRACE` while
leaving `DEPLOY` and `FILEIO` at the quieter INFO default, so you are not drowning in noise from
areas unrelated to the bug you are chasing.

---

## 6. Level gating (`debugEnabled` / `traceEnabled`)

Levels are ordered numerically so a single `<=` compares an event's level against the active
threshold ([event.ts:33-39](../src/shared/diagnostics/event.ts#L33-L39)):

```ts
export enum LogLevel {
  OFF = 0,
  ERROR = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}
```

An event is written when `level <= levelFor(subsystem)`
([logger.ts:153-156](../src/shared/diagnostics/logger.ts#L153-L156)). `write()` re-checks the gate
before doing any work, so a disabled call costs one comparison.

The subtlety the gate exists for: even though `write()` cheaply discards below-threshold events,
**building the `extra` object still costs the caller**. In a hot loop, assembling counts, joining
names, or stringifying a payload for a DEBUG/TRACE row is wasted work if that level is off. The two
public guards let you skip that work entirely
([logger.ts:126-134](../src/shared/diagnostics/logger.ts#L126-L134)):

```ts
public debugEnabled(subsystem: Subsystem): boolean {
  return this.levelEnabled(LogLevel.DEBUG, subsystem);
}
public traceEnabled(subsystem: Subsystem): boolean {
  return this.levelEnabled(LogLevel.TRACE, subsystem);
}
```

**How to use them** — wrap any non-trivial `extra` construction:

```ts
const log = getDiagLogger().begin({ command, correlationId });

for (const component of components) {
  // Cheap fields are fine to always pass. But if building `extra` is expensive, gate it:
  if (log.traceEnabled(Subsystem.FILEIO)) {
    log.trace(Subsystem.FILEIO, 'FILE_WRITTEN', 'wrote component file', {
      // e.g. computing a relative path, hashing, joining dependsOn names — only done at TRACE
      path: component.relativePath,
      depends_on: component.dependsOn.join(','),
    });
  }
}
```

For a plain call with no expensive `extra`, you can skip the guard and just call `log.debug(...)` —
`write()` gates it anyway. The guard is an **optimization for hot paths**, not a correctness
requirement.

---

## 7. Redaction

Redaction is the channel's core safety mechanism. **Every value written to a diagnostic file passes
through redaction first, at all levels.** Tiered privacy governs whether raw names/paths appear at
all (only DEBUG/TRACE), but tokens/secrets are scrubbed unconditionally. There are two passes,
documented at [redact.ts:17-33](../src/shared/diagnostics/redact.ts#L17-L33):

1. **Key-based** — a value whose (normalized) key names a credential is dropped wholesale, so we
   never depend on the value matching a pattern.
2. **Value-pattern** — known secret shapes (JWTs, Salesforce session ids, refresh tokens) and inline
   `key=value` secrets embedded in free text are masked in place.

Three design guarantees back this:

- **Fail-closed.** Any error during traversal (circular refs, hostile getters, depth blow-ups)
  collapses the whole value to `REDACTED_ERROR` (`<REDACTION_FAILED>`) rather than risking a leak.
- **ReDoS-safe.** Every regex is linear; the one lookbehind bounds its separator run to `{1,4}`. The
  comment records that an earlier unbounded lookbehind measured **428 ms** on a 16 KiB adversarial
  input, dropping to **<1 ms** after the fix.
- **Valid JSON out.** The sentinels contain no quote/backslash, so the redacted structure always
  re-serializes.

**Key-based drop set** ([redact.ts:50-72](../src/shared/diagnostics/redact.ts#L50-L72)). Keys are
_normalized_ (lower-cased, non-alphanumerics stripped) before comparison, so `access_token`,
`access-token`, `accessToken`, and `X-Access-Token` all collapse to `accesstoken`:

```ts
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'auth',
  'authtoken',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'sessionid',
  'sid',
  'apikey',
  'privatekey',
  'credentials',
  'credential',
  'xsfdcsession',
]);
```

`isSecretKey` ([redact.ts:84-90](../src/shared/diagnostics/redact.ts#L84-L90)) also strips a leading
`x` so custom HTTP auth headers (`X-Access-Token`, `X-Auth-Token`) are caught.

**Value-shape patterns** ([redact.ts:96-111](../src/shared/diagnostics/redact.ts#L96-L111)):

```ts
const VALUE_PATTERNS: ReadonlyArray<{ re: RegExp; replacement: string }> = [
  // OAuth Bearer header value — keep the scheme word, mask the credential.
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: `Bearer ${REDACTED}` },
  // JSON Web Token: three base64url segments (header.payload.signature); signature may be empty.
  { re: /\bey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, replacement: REDACTED },
  // Salesforce session id: 15/18-char org id, '!', then the token body.
  { re: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._+/=%-]+/g, replacement: REDACTED },
  // Salesforce refresh token prefix.
  { re: /\b5Aep[A-Za-z0-9._%-]+/g, replacement: REDACTED },
  // Inline `key=value` / `key: value` secrets in free text. The lookbehind separator run is bounded
  // to {1,4} (the ReDoS fix); the value class is a single linear negated set.
  {
    re: /(?<=(?:password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|apikey|api_key|sid|sessionid|private_key|authorization)["'\s:=]{1,4})[^\s,"'}{\]]+/gi,
    replacement: REDACTED,
  },
];
```

The fail-closed entry point ([redact.ts:157-168](../src/shared/diagnostics/redact.ts#L157-L168)):

```ts
export function redact(value: unknown): unknown {
  try {
    return redactInner(value, new WeakSet<object>(), 0);
  } catch {
    return REDACTED_ERROR;
  }
}
```

`redactInner` ([redact.ts:128-155](../src/shared/diagnostics/redact.ts#L128-L155)) recurses with a
`WeakSet` to break cycles and a `MAX_DEPTH` of 32; strings are pattern-scrubbed, object values under
a secret key are replaced with `<REDACTED>`, and JSON primitives pass through.

**Path anonymization: `homeScrub`.** Absolute paths logged at DEBUG/TRACE would leak the OS account
name. `homeScrub` ([storage.ts:113-119](../src/shared/diagnostics/storage.ts#L113-L119)) replaces the
home-directory prefix with `~`:

```ts
export function homeScrub(value: string, home: string = homedir()): string {
  if (!home || home.length < 2) {
    return value;
  }
  return value.split(home).join('~');
}
```

> ⚠ **Code vs. docs.** `homeScrub` is **exported but not auto-invoked** by `logger.ts` or
> `redact.ts` — it is the **caller's responsibility** to scrub a path before putting it in `extra`
> (e.g. `log.trace(Subsystem.FILEIO, 'FILE_WRITTEN', homeScrub(fullPath))` or
> `{ path: homeScrub(fullPath) }`). The `diagnostics` command's docs describe scrubbing as automatic
> ("absolute paths are scrubbed to '~' when the logs are written"), and the bundle types claim the
> archive is safe "by construction" because paths were home-scrubbed at write time
> ([types/diagnostics.ts:20-23](../src/shared/types/diagnostics.ts#L20-L23)). That is only true if
> every caller that logs a path calls `homeScrub` first. **When adding path-bearing DEBUG/TRACE
> logs, always wrap the path in `homeScrub` — the logger will not do it for you.** Secrets/tokens
> _are_ scrubbed automatically (redaction runs on every value); the home-path case is the one that
> depends on caller discipline.

---

## 8. Storage: directories, rotation, and gzip

Storage has two jobs ([storage.ts:22-31](../src/shared/diagnostics/storage.ts#L22-L31)): decide **where**
logs live per platform, and keep that directory **bounded**.

### Where logs live

`resolveLogDir` ([storage.ts:62-80](../src/shared/diagnostics/storage.ts#L62-L80)) follows each OS's
convention; `SF_DATACLOUD_LOG_DIR` (resolved in `config.ts`) always wins. The app segment is
`salesforce-datacloud-devops`.

| Platform          | Directory                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| macOS (`darwin`)  | `~/Library/Logs/salesforce-datacloud-devops`                                                                        |
| Windows (`win32`) | `%LOCALAPPDATA%\salesforce-datacloud-devops\logs` (falls back to `~\AppData\Local\...`)                             |
| Linux / other     | `$XDG_STATE_HOME/salesforce-datacloud-devops/logs` (defaults to `~/.local/state/...`) — logs are _state_, not cache |

**File names are deterministic** — `<ts>.<command-slug>.<correlation6>.ndjson`
([storage.ts:103-106](../src/shared/diagnostics/storage.ts#L103-L106)), e.g.
`2026-07-13T18-22-01.data-cloud-deploy.7f3c1a.ndjson`. The 6-char correlation fragment keeps names
unique when two invocations start in the same second. One file is opened per process, shared by the
root logger and every `begin()` child.

### Rotation and retention policy

The policy constants ([storage.ts:36-44](../src/shared/diagnostics/storage.ts#L36-L44)):

```ts
export const ROTATION = {
  /** Roll to a new file once the active one reaches this many bytes. */
  maxFileBytes: 50 * 1024 * 1024, // 50 MB
  /** Keep at most this many diagnostic files (newest wins); older are pruned. */
  maxFiles: 10,
  /** Delete files older than this many days. */
  retentionDays: 7,
} as const;
```

- **Size-based rotation (50 MB).** Driven by an **in-memory byte counter** in `FileSink.append`
  ([logger.ts:95-101](../src/shared/diagnostics/logger.ts#L95-L101)) — never a per-write `statSync`.
  When the counter exceeds `maxFileBytes`, the sink rolls to the next `.N.ndjson` slot via
  `nextRotatedPath` ([storage.ts:131-143](../src/shared/diagnostics/storage.ts#L131-L143)) and resets
  the counter.
- **Count cap (10 files) + age retention (7 days) + lazy gzip** run in a one-time maintenance pass,
  `maintainLogDir` ([storage.ts:181-226](../src/shared/diagnostics/storage.ts#L181-L226)), invoked once
  per process before the first write ([logger.ts:85-90](../src/shared/diagnostics/logger.ts#L85-L90)):

  1. Delete files older than `retentionDays` (never the current file).
  2. Keep only the newest `maxFiles`; prune the rest.
  3. Gzip **at most one** stale uncompressed file per pass (the oldest, least likely to be
     in-progress) to amortize cost — `x.ndjson` → `x.ndjson.gz`, original removed.

  The whole pass is best-effort: a full or unwritable disk is swallowed and never affects a command.

> ⚠ **Code vs. docs (two different limits).** Do not conflate the **50 MB per-file rotation
> threshold** (`ROTATION.maxFileBytes`) with the **~200 MB bundle read cap** (`MAX_BUNDLE_BYTES`,
> [§9](#9-the-diagnostics-command)). The first bounds a single active log file; the second bounds
> how much the `diagnostics` command reads into memory when packing a bundle. They are unrelated
> numbers with different jobs.

---

## 9. The `diagnostics` command

`sf data-cloud diagnostics` packages the local logs into one shippable `.tar.gz`. It touches **no
org and no wire contract** — it reads the on-disk log directory and packs what it finds
([diagnostics.ts:27-34](../src/commands/data-cloud/diagnostics.ts#L27-L34)). The command is thin (flag
parsing, timestamped default output path, human summary); all real work is in the service.

### Flags

| Flag               | Type            | Default                     | Effect                                                                                                                                                             |
| ------------------ | --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--days`           | integer (min 1) | **3**                       | Include log files modified within this many days.                                                                                                                  |
| `--output` / `--o` | string          | timestamped file in the cwd | Path to write the `.tar.gz`. There is no single-dash `-o` short form: the flag declares `aliases: ['o']` (an alternate long name, invoked as `--o`) and no `char`. |
| `--include-env`    | boolean         | `false`                     | Also add `environment.json` (allowlisted, non-sensitive).                                                                                                          |

> ⚠ **Code vs. docs.** The command's `--days` default is **3**
> ([diagnostics.ts:41-45](../src/commands/data-cloud/diagnostics.ts#L41-L45)), while the on-disk
> **retention** window is **7 days** (`ROTATION.retentionDays`). These are independent: retention
> governs how long files survive on disk; `--days` is the default slice the bundle collects. Older
> logs that still exist on disk are collected by passing e.g. `--days 7`.

### What the bundle contains

`collectDiagnosticBundle` ([diagnostics-service.ts:167-223](../src/shared/services/diagnostics-service.ts#L167-L223))
produces:

- **`logs/`** — each in-window NDJSON (or gzipped-stale `.ndjson.gz`) file, newest first, read until
  the ~200 MB `MAX_BUNDLE_BYTES` cap ([diagnostics-service.ts:47-48](../src/shared/services/diagnostics-service.ts#L47-L48))
  would be exceeded. If the cap is hit, collection stops and `truncated` is set — dropped files are
  reported, never silently omitted.
- **`manifest.json`** (bundle root) — a self-describing index
  ([types/diagnostics.ts:78-93](../src/shared/types/diagnostics.ts#L78-L93)): `pluginVersion`,
  `generatedAt`, `days`, `logDir`, a per-file `files[]` list (`name`, `bytes`, `mtime`), `truncated`,
  and `includedEnvironment`. Support can triage from the manifest without extracting every file.
- **`environment.json`** (only with `--include-env`) — an allowlisted, non-sensitive snapshot from
  `buildEnvironmentInfo` ([diagnostics-service.ts:87-103](../src/shared/services/diagnostics-service.ts#L87-L103)):
  `pluginVersion`, `nodeVersion`, `platform`, `arch`, `osRelease`, and only the environment variables
  named in `SAFE_ENV_ALLOWLIST`.

**The environment allowlist** ([types/diagnostics.ts:32-43](../src/shared/types/diagnostics.ts#L32-L43)) —
strictly an allowlist, so a secret sitting in the environment can never reach the bundle:

```ts
export const SAFE_ENV_ALLOWLIST: readonly string[] = [
  // This plugin's diagnostic-logging configuration (never carries a secret).
  'SF_DATACLOUD_LOG_LEVEL',
  'SF_DATACLOUD_LOG_LEVEL_API',
  'SF_DATACLOUD_LOG_LEVEL_DEPLOY',
  'SF_DATACLOUD_LOG_LEVEL_FILEIO',
  'SF_DATACLOUD_LOG_DIR',
  // Coarse CLI/runtime toggles useful for reproducing an environment; none are credentials.
  'SF_DISABLE_TELEMETRY',
  'NODE_ENV',
  'CI',
];
```

### The archive encoding (USTAR)

Node ships gzip (`node:zlib`) but no tar, and the project prefers builtins over new npm deps, so
`tar-writer.ts` hand-rolls a minimal **write-only USTAR** encoder
([tar-writer.ts:17-27](../src/shared/diagnostics/tar-writer.ts#L17-L27)): regular files only, POSIX
USTAR format, names ≤ 100 bytes. Each entry is a 512-byte header + data padded to a 512-byte
boundary; two zero blocks terminate the archive. It is pure and deterministic (mtime is
caller-supplied), so a `tar -tzf` round-trip test fully covers it. `collectDiagnosticBundle` runs
the entries through `tarball()` then `gzipSync` and writes the result
([diagnostics-service.ts:211-214](../src/shared/services/diagnostics-service.ts#L211-L214)).

### Running it

```console
$ sf data-cloud diagnostics
Wrote diagnostic bundle to /Users/you/datacloud-diagnostics-2026-07-13T18-40-12.tar.gz
Included 3 log file(s) from the last 3 day(s).
```

```console
$ sf data-cloud diagnostics --days 7 --include-env --output ./datacloud-diag.tar.gz
Wrote diagnostic bundle to /Users/you/project/datacloud-diag.tar.gz
Included 5 log file(s) from the last 7 day(s).
```

Inspect the result without extracting:

```console
$ tar -tzf datacloud-diagnostics-2026-07-13T18-40-12.tar.gz
logs/2026-07-13T18-22-01.data-cloud-deploy.7f3c1a.ndjson
logs/2026-07-12T09-15-33.data-cloud-retrieve.a1b2c3.ndjson
logs/2026-07-11T14-02-08.data-cloud-deploy-status.d4e5f6.ndjson
manifest.json
environment.json
```

With `--json`, the command returns the `DiagnosticsResult` shape
([types/diagnostics.ts:95-107](../src/shared/types/diagnostics.ts#L95-L107)): `outputPath`,
`fileCount`, `totalBytes`, `truncated`, `includedEnvironment`. The default output name is
`datacloud-diagnostics-<timestamp>.tar.gz`
([diagnostics-service.ts:226-228](../src/shared/services/diagnostics-service.ts#L226-L228)).

**Typical workflow:** raise verbosity → reproduce → bundle.

```bash
SF_DATACLOUD_LOG_LEVEL=DEBUG sf data-cloud deploy --source-dir ./data-cloud   # reproduce the issue
sf data-cloud diagnostics --include-env                                        # collect + attach to the ticket
```

---

## 10. The plugin-version resolver

Every row's `plugin_version` field comes from `getPluginVersion()`
([plugin-version.ts:38-51](../src/shared/diagnostics/plugin-version.ts#L38-L51)). Services live below
the command layer and cannot reach oclif's `this.config.version`, so the resolver reads the plugin's
**own `package.json`** directly. It is **lazy and memoized**: the read happens on the first call
(never at module load — an import-side-effect-free invariant), is cached thereafter, and degrades to
the literal `'unknown'` on any read/parse failure rather than throwing.

```ts
const UNKNOWN = 'unknown';
let cached: string | undefined;

export function getPluginVersion(): string {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const pkgUrl = new URL('../../../package.json', import.meta.url);
    const raw = readFileSync(pkgUrl, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : UNKNOWN;
  } catch {
    cached = UNKNOWN;
  }
  return cached;
}
```

The `../../../package.json` relative URL resolves correctly in both dev
(`src/shared/diagnostics/`, ts-node) and compiled (`lib/shared/diagnostics/`) layouts, since both sit
three levels below the package root ([plugin-version.ts:34-37](../src/shared/diagnostics/plugin-version.ts#L34-L37)).
The version is read once in `FileSink`'s constructor
([logger.ts:75](../src/shared/diagnostics/logger.ts#L75)) and stamped on every row, and again by the
bundle's manifest/environment snapshot.

---

## 11. Testing diagnostics

Two modules memoize process-global state to satisfy the "no side effects at import / cheap when off"
invariants. Both would otherwise make tests order-dependent — the first test's environment would
stick for the whole suite. Each exposes a reset seam:

- **`resetDiagLoggerForTest()`** ([logger.ts:253-255](../src/shared/diagnostics/logger.ts#L253-L255))
  drops the cached `DiagLogger` singleton so the next `getDiagLogger()` re-reads the environment (and
  re-decides `anyEnabled`).

  ```ts
  export function resetDiagLoggerForTest(): void {
    singleton = undefined;
  }
  ```

- **`resetPluginVersionForTest()`** ([plugin-version.ts:54-56](../src/shared/diagnostics/plugin-version.ts#L54-L56))
  clears the memoized version so a suite can re-exercise the resolve and the `'unknown'` fallback
  paths.

  ```ts
  export function resetPluginVersionForTest(): void {
    cached = undefined;
  }
  ```

**Why they exist:** the singleton and the version cache are populated on first use and never
reconsidered, which is correct for production (one process, one config) but hostile to tests, which
flip env vars between cases. The seams let each test start from a clean slate.

**How tests use them** — reset in a `beforeEach`, set env, then exercise:

```ts
import { resetDiagLoggerForTest, getDiagLogger } from '../src/shared/diagnostics/logger.js';
import { resetPluginVersionForTest } from '../src/shared/diagnostics/plugin-version.js';

beforeEach(() => {
  resetDiagLoggerForTest();
  resetPluginVersionForTest();
});

it('is a no-op when disabled', () => {
  process.env.SF_DATACLOUD_LOG_LEVEL = 'OFF';
  const log = getDiagLogger(); // re-reads env → disabled, no-op logger
  log.info(Subsystem.CORE, 'X', 'nothing is written'); // opens no file
});
```

The pure helpers make most of the system testable **without** these seams: `resolveDiagConfig(env)`
takes an injectable `Env`, `resolveLogDir({...})` / `homeScrub(value, home)` take injectable
os/env inputs, and `collectDiagnosticBundle({...})` takes an injectable clock, log dir, byte cap, and
`Env` — so the bundle path unit-tests deterministically without touching the real platform.

---

## See also

- **[TELEMETRY.md](TELEMETRY.md)** — the remote metrics channel (Azure App Insights). The
  counterpart to this document; the two channels are fully independent.
- **[DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md)** — the cross-cutting invariants
  (never-throws, deterministic file names, redaction, scope boundaries) this channel embodies.
- **[CLAUDE.md](../CLAUDE.md)** / `PROJECT_KNOWLEDGE.md` — project scope, the five commands, and the
  hard rules. Where these disagree with the source, the **⚠ Code vs. docs** callouts above record
  which one wins (the code).
