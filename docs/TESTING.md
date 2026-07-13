# Testing Strategy

How `@salesforce/plugin-datacloud-devops` is tested: the test-tree layout, the unit-test
patterns (sinon + `@salesforce/core` `TestContext`), when to reach for a NUT, the telemetry and
diagnostics test utilities, mock fixtures, coverage, the exact commands to run, the
schema/reference/policy guards, and a step-by-step recipe for adding tests to a new command or
service.

> Companion docs: [ARCHITECTURE.md](ARCHITECTURE.md) (layering), [ADDING_A_COMMAND.md](ADDING_A_COMMAND.md)
> (command scaffolding), [TELEMETRY.md](TELEMETRY.md) (the privacy contract these tests enforce),
> [DIAGNOSTICS.md](DIAGNOSTICS.md) (the local NDJSON channel and redaction), and
> [ERROR_HANDLING.md](ERROR_HANDLING.md) (the structured errors tests assert on).

## Test stack at a glance

The plugin is an ESM package (`"type": "module"` in [`package.json`](../package.json)). The test
stack comes transitively through `@salesforce/dev-scripts`:

| Concern            | Tool                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| Runner             | `mocha` (ESM, via the `ts-node/esm` loader)                              |
| Assertions         | `chai` (`expect`)                                                        |
| Stubs / spies      | `sinon` (surfaced through `@salesforce/core` `TestContext`)              |
| Coverage           | `nyc`                                                                    |
| Org / connection   | `@salesforce/core/testSetup` (`TestContext`, `MockTestOrgData`)          |
| UX stubbing        | `@salesforce/sf-plugins-core` (`stubSfCommandUx`)                        |
| End-to-end (NUTs)  | `@salesforce/cli-plugins-testkit` (`TestSession`, `execCmd`)             |
| Snapshot / schema  | `@oclif/plugin-command-snapshot`, `@salesforce/plugin-command-reference` |
| Task orchestration | `wireit` (the `test` script fans out to all checks)                      |

> Note: this repo uses **mocha + chai + nyc + sinon**, not JUnit. `CLAUDE.md` / `PROJECT_KNOWLEDGE.md`
> mention "JUnit, ≥80% coverage" and "FIT tests" — that reflects the Java contract side and an
> aspirational target, not the JavaScript toolchain checked into this package. See
> [Conflicts with project docs](#conflicts-with-project-docs) at the end.

---

## 1. Test structure mirrors `src/`

Every test lives under `test/`, and its path mirrors the file under test in `src/`. Find the source
file, prefix `test/`, and append `.test.ts` — that is where the test is (or where a new one goes).

```
src/                                          test/
├── commands/                                 ├── commands/
│   ├── data-cloud/                           │   ├── data-cloud/
│   │   ├── component-type/list.ts            │   │   ├── component-type/…      (command tests)
│   │   ├── component/list.ts                 │   │   ├── component/…
│   │   ├── deploy/index.ts                   │   │   ├── deploy.test.ts
│   │   ├── deploy/status.ts                  │   │   ├── deploy/status.test.ts
│   │   ├── diagnostics.ts                    │   │   ├── diagnostics.test.ts
│   │   └── retrieve.ts                       │   │   └── retrieve.test.ts
│   └── hello/                                │   └── hello/
│       └── world.ts                          │       └── world.nut.ts          (the only NUT today)
├── shared/                                   ├── shared/
│   ├── services/                             │   ├── services/
│   │   ├── deploy-service.ts                 │   │   ├── deploy-service.test.ts
│   │   ├── deploy-status-service.ts          │   │   ├── deploy-status-service.test.ts
│   │   ├── devops-api.ts                     │   │   ├── devops-api.test.ts
│   │   ├── diagnostics-service.ts            │   │   ├── diagnostics-service.test.ts
│   │   ├── file-reader.ts                    │   │   ├── file-reader.test.ts
│   │   ├── file-writer.ts                    │   │   ├── file-writer.test.ts
│   │   ├── retrieve-service.ts               │   │   ├── retrieve-service.test.ts
│   │   └── telemetry.ts                      │   │   └── telemetry.test.ts
│   ├── diagnostics/                          │   ├── diagnostics/
│   │   ├── config.ts                         │   │   ├── config.test.ts
│   │   ├── logger.ts                         │   │   ├── logger.test.ts
│   │   ├── plugin-version.ts                 │   │   ├── plugin-version.test.ts
│   │   ├── redact.ts                         │   │   ├── redact.test.ts
│   │   ├── storage.ts                        │   │   ├── storage.test.ts
│   │   └── tar-writer.ts                     │   │   └── tar-writer.test.ts
│   └── constants/component-paths.ts          │   └── constants/
│                                             │       └── component-paths.test.ts
│                                             ├── shared/telemetry-test-utils.ts (shared helpers)
│                                             └── setup.ts                       (global bootstrap)
```

Two files under `test/shared/` are **infrastructure, not tests** (no `.test.ts` suffix):

- [`test/setup.ts`](../test/setup.ts) — the global bootstrap (see §7).
- [`test/shared/telemetry-test-utils.ts`](../test/shared/telemetry-test-utils.ts) — shared telemetry
  assertion helpers (see §4).

The test tree is compiled by its own [`test/tsconfig.json`](../test/tsconfig.json) (which extends
`@salesforce/dev-config/tsconfig-test-strict-esm`), separate from the production
[`tsconfig.json`](../tsconfig.json) that only includes `./src/**/*.ts`. Tests import source with a
`.js` extension and a relative path back into `src/` (ESM requires the `.js` suffix), for example:

```ts
import DataCloudRetrieve from '../../../src/commands/data-cloud/retrieve.js';
import { checkDeployStatus } from '../../../src/shared/services/deploy-status-service.js';
```

---

## 2. Unit tests: `TestContext`, `MockTestOrgData`, and stubbing

Unit tests never touch the network, a real org, or the developer's real filesystem. Three things get
stubbed: the **Connection** (HTTP boundary), the **filesystem** (isolated temp dirs), and
**`Lifecycle`** (telemetry). The primary tool is `@salesforce/core`'s `TestContext`, conventionally
bound to `$$`, which wraps a sinon sandbox and knows how to fake auth and HTTP.

### The `TestContext` + `MockTestOrgData` pattern

Command tests instantiate `TestContext` and `MockTestOrgData` once at the `describe` level, stub UX
and auth in `beforeEach`, and restore in `afterEach`. From
[`test/commands/data-cloud/retrieve.test.ts`](../test/commands/data-cloud/retrieve.test.ts):

```ts
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { AnyJson } from '@salesforce/ts-types';

describe('data-cloud retrieve', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let origCwd: string;
  let tmp: string;
  let telemetry: TelemetryEvent[];

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);   // capture command UX (log/table)
    telemetry = [];
    captureTelemetry(telemetry);                    // subscribe to the Lifecycle telemetry channel
    await $$.stubAuths(testOrg);                     // make the mock org resolvable by username
    // Fake ONLY the HTTP boundary; the real command + service + file-writer path runs.
    $$.fakeConnectionRequest = (request: AnyJson): Promise<AnyJson> => {
      const url = typeof request === 'string' ? request : '';
      const dataspace = new URL(url, 'https://example.com').searchParams.get('dataSpaceName') ?? 'default';
      return Promise.resolve(getMockRetrieveApiResponse(dataspace) as unknown as AnyJson);
    };
    origCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'dc-cmd-'));    // isolate the data-cloud/ tree the command writes
    process.chdir(tmp);
  });

  afterEach(() => {
    // Restore cwd FIRST so a later cleanup throw can't strand the process in the temp dir.
    process.chdir(origCwd);
    resetTelemetry();
    $$.restore();
    rmSync(tmp, { recursive: true, force: true });
  });
```

What each stub buys you:

- **`stubSfCommandUx($$.SANDBOX)`** returns stubs for the command's UX methods. Assert on printed
  output by joining the captured `log` calls:

  ```ts
  const output = sfCommandStubs.log
    .getCalls()
    .flatMap((c) => c.args)
    .join('\n');
  expect(output).to.include('Retrieved 5 components');
  expect(output).to.include('Files written to ./data-cloud/default/');
  ```

- **`$$.stubAuths(testOrg)`** makes `--src-org`/`--target-org <testOrg.username>` resolve to a fake
  authenticated org, so command tests exercise real org resolution without a live login.

- **`$$.fakeConnectionRequest`** intercepts at the `Connection.request` boundary. The request that
  reaches it is the versioned Connect API URL the service built, so a test can branch on it (the
  retrieve test parses `dataSpaceName` out of the query string). This is the seam that keeps tests
  offline while still running the command → service → file-writer stack for real.

- **cwd isolation.** Commands write the `data-cloud/` tree relative to `process.cwd()`, and
  `data-cloud/` is not gitignored, so each test `chdir`s into a fresh `mkdtempSync` dir and removes
  it afterward — restoring cwd **before** the `rmSync` so a cleanup throw can't strand the process.

### Stubbing a plain `Connection` in a service test

Service tests don't need the full command harness — the service takes a `Connection` and hands it
to the API client, so a minimal hand-rolled stand-in is enough. From
[`test/shared/services/deploy-status-service.test.ts`](../test/shared/services/deploy-status-service.test.ts):

```ts
import { Connection } from '@salesforce/core';

const fakeConn = (opts: { response?: DeployStatusApiResponse; reject?: unknown; orgId?: string }): Connection =>
  ({
    getApiVersion: () => '62.0',
    getAuthInfoFields: () => ({ orgId: opts.orgId }), // what safeOrgId reads for the orgId tag
    request: () => (opts.reject ? Promise.reject(opts.reject) : Promise.resolve(opts.response)),
  } as unknown as Connection);
```

You either resolve `request` with the raw PascalCase wire body (happy path) or reject it with a
`{ errorCode, message }` shape to exercise the error-mapping path — without a network round-trip.
[`test/shared/services/devops-api.test.ts`](../test/shared/services/devops-api.test.ts) goes one
level deeper: its `makeConn` helper **records** the arguments passed to `request`, so tests can
assert on the exact versioned path and POST body the client constructed.

### Testing the error paths

For each error branch, assert the **structured error class name** (not raw message text). From the
deploy-status service test:

```ts
it('re-throws the ORIGINAL mapped error', async () => {
  const conn = fakeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
  try {
    await checkDeployStatus(conn, JOB_ID);
    expect.fail('Should have thrown');
  } catch (error) {
    expect((error as Error).name).to.equal('DataCloudApiAuthError');
  }
});
```

Command-layer flag/org errors are asserted the same way (from the retrieve test):

```ts
// Missing required flag:
expect((error as Error).message).to.include('Missing required flag component');
// Missing org (tolerant regex — the exact core wording varies):
expect((error as Error).message).to.match(/org|target-org|src-org|default environment/i);
```

---

## 3. Integration tests (NUTs): real CLI invocations

NUTs ("Not-Unit-Tests") run the built plugin as a real subprocess with
`@salesforce/cli-plugins-testkit`. They live in `*.nut.ts` files and are picked up only by
`test:nuts` (never by `test:only`, which explicitly excludes `*.nut.ts`).

The canonical example is [`test/commands/hello/world.nut.ts`](../test/commands/hello/world.nut.ts):

```ts
import { execCmd, TestSession } from '@salesforce/cli-plugins-testkit';
import { expect } from 'chai';
import { HelloWorldResult } from '../../../src/commands/hello/world.js';

let testSession: TestSession;

describe('hello world NUTs', () => {
  before('prepare session', async () => {
    testSession = await TestSession.create();
  });

  after(async () => {
    await testSession?.clean();
  });

  it('should say hello to the world', () => {
    const result = execCmd<HelloWorldResult>('hello world --json', { ensureExitCode: 0 }).jsonOutput?.result;
    expect(result?.name).to.equal('World');
  });
});
```

Key differences from a unit test:

- `TestSession.create()` provisions a sandboxed session (its own temp `HOME`/config), cleaned in
  `after`.
- `execCmd(...)` **shells out** to the real CLI; assert on `--json` output and enforce the process
  exit code with `ensureExitCode: 0`.
- No `TestContext`, no sinon, no `fakeConnectionRequest` — nothing is stubbed; the whole binary runs.

**When to write a NUT** (vs. a unit test):

- The behaviour only manifests through the actual oclif runtime: flag parsing, exit codes,
  `--json` envelope shape, topic/subtopic routing, or process-level output.
- You want a smoke test that the built command is wired up and runnable end to end.
- You are validating a full workflow across process boundaries (e.g. a future `retrieve` → `deploy`
  → `deploy status` round-trip against an orgfarm org).

**When NOT to** — prefer a unit test whenever you can inject a fake `Connection` or exercise a
service function directly. Unit tests are faster, hermetic, and give branch-level coverage; NUTs are
slow (`--timeout 600000`) and need a session. Today `world.nut.ts` is the **only** NUT in the repo —
the `data-cloud` commands are covered by fast, `fakeConnectionRequest`-based command tests, and the
retrieve→deploy→status NUT against an orgfarm org is future work.

---

## 4. Telemetry test utilities

[`test/shared/telemetry-test-utils.ts`](../test/shared/telemetry-test-utils.ts) is the shared
harness that subscribes to the `Lifecycle` telemetry channel and enforces the
[privacy contract](TELEMETRY.md): **no** component names, dataspace names, paths, emails, or error
messages may leak into a telemetry payload (with two narrowly-scoped, documented exceptions).

Exported helpers:

| Helper                        | Purpose                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `captureTelemetry(sink)`      | Registers a **synchronous** listener that pushes each emitted event into `sink[]`.         |
| `resetTelemetry()`            | Removes all telemetry listeners from the process-global `Lifecycle` (call in `afterEach`). |
| `ourEvents(sink)`             | Filters `sink` to events whose `eventName` starts with `DATACLOUD_DEVOPS_`.                |
| `assertNoUnsafeFields(event)` | Privacy-checks a single event (forbidden keys + unsafe value scan).                        |
| `assertAllSafe(sink)`         | Runs `assertNoUnsafeFields` over every plugin event in `sink`.                             |
| `UUID_RE`                     | RFC-4122 v4 regex for asserting a client-generated `correlationId`.                        |
| `TelemetryEvent`              | `Record<string, unknown>` — the flat payload shape `onTelemetry` hands you.                |

Because `captureTelemetry` pushes **during** `emit()` (before the awaited call returns), a test can
assert on `sink` immediately after awaiting — no flush needed:

```ts
let telemetry: TelemetryEvent[];

beforeEach(() => {
  telemetry = [];
  captureTelemetry(telemetry);
});
afterEach(() => resetTelemetry());

it('emits exactly one safe event with graph size', async () => {
  await deployComponents(fakeConn({ orgId: '00DXX0000000000AAA' }), 'CalculatedInsight:highValueCustomer', 'default', {
    baseDir: tmp,
  });

  const events = ourEvents(telemetry);
  expect(events).to.have.lengthOf(1);
  const e = events[0];
  expect(e.eventName).to.equal('DATACLOUD_DEVOPS_DEPLOY_COMPONENT');
  expect(e.surface).to.equal('cli');
  expect(e.correlationId).to.match(UUID_RE);
  expect(e.componentType).to.equal('CalculatedInsight');
  expect(e.componentCount).to.equal(2); // CI + its one DMO dependency
  expect(e.lifecycleStatus).to.equal('SUBMITTED');
  expect(Number.isInteger(e.durationMs)).to.equal(true);
  assertAllSafe(telemetry); // the privacy gate
});
```

`assertAllSafe` is the privacy backstop. Internally it checks each event against `FORBIDDEN_KEYS`
(`componentName`, `dataspace`, `path`, `targetComponent`, `message`, `error`, `username`, `email`, …)
and scans every string value against an `UNSAFE_VALUE` regex built from the concrete mock values
(`highValueCustomer`, `Divvy_Trips`, `analytics_ds`, `Session expired`, a path separator, an `@`).
Two documented exceptions are encoded in the util itself:

- `errorMessage` on error-path events is intentionally free text (it may carry mapped backend
  detail) and is excluded from the value scan.
- The `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE` sub-event is the **one** place `componentName`
  (and an unbounded `componentType`/`errorMessage`) is allowed. Every other event stays fully
  bounded.

A negative assertion pattern used throughout is stringifying the whole event and asserting the raw
value never appears — even where a bounded field is legal:

```ts
expect(JSON.stringify(poll)).to.not.match(/MyCi|bad expression/); // the bounded poll event leaks nothing
expect(Object.keys(e)).to.not.include('message'); // key is `errorMessage`, never `message`
```

Two invariants worth copying into every telemetry test: a fresh `correlationId` per top-level
operation (`UUID_RE`), and **a throwing telemetry listener must never break the operation**:

```ts
it('never lets a throwing telemetry listener break the deploy', async () => {
  Lifecycle.getInstance().onTelemetry(() => {
    throw new Error('telemetry boom');
  });
  const result = await deployComponents(fakeConn(), 'CalculatedInsight:highValueCustomer', 'default', { baseDir: tmp });
  expect(result.status).to.equal('SUBMITTED');
});
```

The **diagnostics** side has its own contract enforced by
[`test/shared/diagnostics/redact.test.ts`](../test/shared/diagnostics/redact.test.ts): `redact`,
`redactString`, and `isSecretKey` mask secrets by value shape (JWTs, Bearer tokens, Salesforce
session/refresh tokens, inline `key=value` secrets) and by key name, fail closed on circular
references, return a redacted clone (never mutating the input), stay valid JSON, and resist ReDoS
(a 16 KiB adversarial input in well under 50 ms). See [DIAGNOSTICS.md](DIAGNOSTICS.md).

---

## 5. Mock data: `src/shared/mocks/`

Mocks are **typed, realistic fixtures** that live in production `src/` (not `test/`), but they are
consumed only by **tests** (and by `retrieve.mock.ts` as a reference of the returned shape) — no
command or service imports them anymore. The commands/services now call the **real Connect API
client**: retrieve fetches live data via `getSnapshot` (`retrieve-service.ts`), and the list commands
call `getComponentTypes` / `getComponents`. Instead, tests feed these fixtures through
`fakeConnectionRequest` (or a hand-rolled fake `Connection`) to exercise the real command → service →
file-writer path against the exact wire shape the backend returns.

| Fixture                                                                              | Shape it provides                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [`retrieve-api-response.mock.ts`](../src/shared/mocks/retrieve-api-response.mock.ts) | The **raw** `GET .../component/snapshot` response — each component **with** its `entityPayload`. The input to the file-writer. |
| [`retrieve.mock.ts`](../src/shared/mocks/retrieve.mock.ts)                           | The **standardized** `RetrieveResult` (payloads stripped). Superseded, kept as a reference of the returned shape.              |
| `component-types.mock.ts`, `components.mock.ts`, `deploy.mock.ts`                    | Fixtures for the list and deploy commands.                                                                                     |

All fixtures are typed against the real contract types (`RetrieveApiResponse`, `RetrieveResult`) and
share **the same five components, order, and `dependsOn` edges**: a `CalculatedInsight`
(`highValueCustomer`) → `DataModelObject` (`Divvy_TripsDmo`), a `DataTransform` (`myTransform`) →
`DataLakeObject` (`myDLO`) → `DataModelObject` (`AccountDmo`). This is the CI+DMO (+DataTransform)
graph the sprint must prove end to end.

Typical consumption: a test picks the fixture and feeds it through the real code path. The command
test wires it into `fakeConnectionRequest` (keyed on the requested dataspace):

```ts
$$.fakeConnectionRequest = (request: AnyJson): Promise<AnyJson> => {
  const url = typeof request === 'string' ? request : '';
  const dataspace = new URL(url, 'https://example.com').searchParams.get('dataSpaceName') ?? 'default';
  return Promise.resolve(getMockRetrieveApiResponse(dataspace) as unknown as AnyJson);
};
```

The deploy service test uses the same fixture to **populate a real on-disk tree** before deploying,
so the read-and-walk path runs for real:

```ts
const { components } = getMockRetrieveApiResponse('default');
await writeRetrievedComponents(components, { baseDir: tmp }); // writes data-cloud/ under a temp dir
// …then:
const result = await deployComponents(fakeConn(), 'CalculatedInsight:highValueCustomer', 'default', { baseDir: tmp });
```

Because the fixture's component names (`highValueCustomer`, `Divvy_Trips`, `AccountDmo`, …) are
exactly the strings baked into the telemetry util's `UNSAFE_VALUE` regex, any leak of a mock value
into a telemetry payload is caught automatically by `assertAllSafe`.

---

## 6. Coverage

Coverage is measured by `nyc` and reported on every unit-test run (`test:only` and `test:nuts` both
invoke `nyc mocha …`). The config is [`.nycrc`](../.nycrc), which extends the shared
`@salesforce/dev-config/nyc` preset:

```jsonc
// .nycrc
{ "extends": "@salesforce/dev-config/nyc" }
```

The preset (`node_modules/@salesforce/dev-config/nyc.json`) sets:

```jsonc
{
  "check-coverage": true,
  "lines": 50,
  "statements": 50,
  "functions": 50,
  "branches": 50,
  "reporter": ["lcov", "text"],
  "extension": [".ts"],
  "include": ["**/*.ts"],
  "exclude": ["**/*.d.ts", "**/*.test.ts"]
}
```

**Reading the report.** The `text` reporter prints a per-file table to the terminal at the end of the
run; the `lcov` reporter writes `coverage/lcov-report/index.html` (open it in a browser for
line-by-line highlighting) plus `coverage/lcov.info` for CI upload. `check-coverage: true` means the
run **fails** if any metric drops below threshold.

> **Threshold caveat.** The checked-in config enforces **50%**, not 80%. The **≥80%** figure in
> `CLAUDE.md` / `PROJECT_KNOWLEDGE.md` is the project's stated goal (and the bar for the Java
> contract classes), but it is **not** what the local `nyc` config enforces today. To pin 80%
> locally, override in `.nycrc`:
>
> ```jsonc
> { "extends": "@salesforce/dev-config/nyc", "lines": 80, "statements": 80, "functions": 80, "branches": 80 }
> ```
>
> In practice the suite already sits well above 50% — the services and diagnostics modules each have
> dozens of branch-level cases (see `devops-api.test.ts`, `deploy-status-service.test.ts`,
> `redact.test.ts`).

---

## 7. Running tests

```bash
yarn test        # the full gate (wireit graph) — run this before pushing
yarn test:only   # unit tests + coverage ONLY (fast inner loop)
yarn test:nuts   # NUTs against the built plugin (slow)
```

### `yarn test` — the full wireit gate

`test` is a `wireit` task whose `dependencies` fan out to the complete pre-merge gate (from
[`package.json`](../package.json)):

```
test
├── test:compile            # tsc -p ./test  (type-check the test tree)
├── test:only               # unit tests + coverage
├── test:command-reference  # commandreference:generate --erroronwarnings   (§8)
├── test:deprecation-policy # snapshot:compare                              (§8)
├── lint                    # eslint src test
├── test:json-schema        # schema:compare                               (§8)
└── link-check              # linkinator on *.md (skipped in CI)
```

wireit caches each task against its declared input files, so unchanged tasks are skipped on re-run.
Note that `yarn test` **does not** run NUTs — run `yarn test:nuts` separately.

### `yarn test:only` — the fast inner loop

```jsonc
// package.json → wireit.test:only
"command": "nyc mocha \"test/**/*.test.ts\"",
"env": { "FORCE_COLOR": "2" },
"files": ["test/**/*.ts", "src/**/*.ts", "**/tsconfig.json", ".mocha*", "!*.nut.ts", ".nycrc"]
```

It runs every `*.test.ts` under coverage. The `!*.nut.ts` in `files` means editing a NUT does not
invalidate this task's cache — NUTs are a separate concern.

### `yarn test:nuts`

```jsonc
"test:nuts": "nyc mocha \"**/*.nut.ts\" --slow 4500 --timeout 600000 --parallel"
```

Globs `*.nut.ts` anywhere, runs them in parallel with a 10-minute timeout and a 4.5 s slow threshold.
These need a `TestSession` (and, for real orgs, credentials), so they are not part of `yarn test`.

### `.mocharc.json` — how mocha runs under ESM

[`.mocharc.json`](../.mocharc.json) is the shared runner config for all three commands:

```jsonc
{
  "require": ["ts-node/register", "./test/setup.ts"], // transpile TS + run the global bootstrap
  "watch-extensions": "ts",
  "recursive": true,
  "reporter": "spec",
  "timeout": 600000,
  "node-option": ["loader=ts-node/esm"] // ESM loader so .ts imports resolve
}
```

Two `require` entries matter:

- `ts-node/register` (+ the `loader=ts-node/esm` node option) lets mocha run TypeScript ESM directly,
  no pre-build.
- [`./test/setup.ts`](../test/setup.ts) is the **global bootstrap**, run once before any test file
  loads. Its sole job is containment for the diagnostics logger: the diagnostic channel is on by
  default (INFO), so without this, a test that drives a real orchestrator would write NDJSON into the
  developer's real `~/Library/Logs/…` dir and run prune/gzip against real files. It redirects
  `SF_DATACLOUD_LOG_DIR` to a throwaway temp dir — but only if the var is not already set, so CI or a
  per-test override still wins:

  ```ts
  if (!process.env.SF_DATACLOUD_LOG_DIR) {
    process.env.SF_DATACLOUD_LOG_DIR = mkdtempSync(join(tmpdir(), 'dc-diag-test-'));
  }
  ```

---

## 8. Schema, reference, and policy validation

Three `wireit` tasks in the `test` gate guard the **public contract** of the CLI — the parts an
external tool or a user script depends on. They pass only if the code matches the checked-in
snapshot/schema artifacts, so a contract change is a deliberate, reviewable diff.

| Task                      | Command                                                  | Guards                                                                      | Fix / update                                             |
| ------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `test:json-schema`        | `bin/dev.js schema:compare`                              | The per-command JSON `--json` result schemas in `schemas/`                  | Regenerate the schemas (see below) and commit the diff.  |
| `test:command-reference`  | `bin/dev.js commandreference:generate --erroronwarnings` | Every flag/command has complete help metadata (no warnings)                 | Fix the missing summary/description on the flag/command. |
| `test:deprecation-policy` | `bin/dev.js snapshot:compare`                            | No accidental breaking change to commands/flags vs. `command-snapshot.json` | Regenerate the snapshot **only** for an intended change. |

Where the artifacts live:

- **Schemas:** [`schemas/`](../schemas) — one file per command, e.g. `data__cloud-retrieve.json`,
  `data__cloud-deploy.json`, `data__cloud-deploy-status.json`, `data__cloud-component-list.json`,
  `data__cloud-component__type-list.json`, `data__cloud-diagnostics.json`, `hello-world.json`.
- **Snapshot:** [`command-snapshot.json`](../command-snapshot.json) at the repo root — the frozen
  list of commands and their flags.

**Updating snapshots/schemas** (do this deliberately, and review the diff):

```bash
./bin/dev.js snapshot:generate     # regenerate command-snapshot.json after an INTENDED command/flag change
./bin/dev.js schema:generate       # regenerate the schemas/ files after an INTENDED result-shape change
yarn build                         # snapshot:compare depends on compile; build first
```

A **failing** `snapshot:compare` on a change you did not intend is a warning that you just altered
the public CLI surface (renamed a flag, changed a result field) — revert it rather than regenerating.
`--erroronwarnings` on the command-reference task means a missing flag summary is a hard failure, not
a warning.

---

## 9. Adding tests for a new command or service

Follow the mirror (§1), then cover the success path, **each** error path, and the telemetry contract.
See [ADDING_A_COMMAND.md](ADDING_A_COMMAND.md) for the source-side scaffolding; this is the test
side.

### For a new **service** (`src/shared/services/foo-service.ts`)

1. Create `test/shared/services/foo-service.test.ts`.
2. Build a minimal fake `Connection` (§2). Resolve `request` with a fixture for the happy path;
   reject it with `{ errorCode, message }` for the API-error path. Add `getApiVersion` and
   `getAuthInfoFields` so path-versioning and the `orgId` tag work.
3. Wire telemetry capture:

   ```ts
   let telemetry: TelemetryEvent[];
   beforeEach(() => {
     telemetry = [];
     captureTelemetry(telemetry);
   });
   afterEach(() => resetTelemetry());
   ```

4. **Success path** — assert the returned value **and** exactly one safe event:

   ```ts
   const result = await foo(fakeConn({ orgId: '00DXX0000000000AAA' }), args);
   expect(result.status).to.equal('SUBMITTED');
   const events = ourEvents(telemetry);
   expect(events).to.have.lengthOf(1);
   expect(events[0].eventName).to.equal('DATACLOUD_DEVOPS_FOO');
   expect(events[0].correlationId).to.match(UUID_RE);
   assertAllSafe(telemetry);
   ```

5. **Each error path** — assert the structured error **name** and one failure event that carries
   `errorCode` but never a raw `message`:

   ```ts
   try {
     await foo(fakeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } }), args);
     expect.fail('Should have thrown');
   } catch (error) {
     expect((error as Error).name).to.equal('DataCloudApiAuthError'); // original error preserved
   }
   const e = ourEvents(telemetry)[0];
   expect(e.success).to.equal(false);
   expect(e.errorCode).to.equal('DataCloudApiAuthError');
   expect(Object.keys(e)).to.not.include('message');
   expect(JSON.stringify(e)).to.not.match(/Session expired/);
   assertAllSafe(telemetry);
   ```

6. **Resilience** — a throwing telemetry listener must not break the operation (§4).
7. If the service reads/writes files, pre-populate a `mkdtempSync` temp dir with
   `writeRetrievedComponents(getMockRetrieveApiResponse('default').components, { baseDir: tmp })`
   and pass `{ baseDir: tmp }`; `rmSync` it in `afterEach`.

### For a new **command** (`src/commands/data-cloud/foo.ts`)

1. Create `test/commands/data-cloud/foo.test.ts` (a command that is also a topic lives in a
   `foo/index.ts` — see the deploy command; import it as `.../foo/index.js`).
2. Use the full harness: `const $$ = new TestContext(); const testOrg = new MockTestOrgData();`, then
   `stubSfCommandUx($$.SANDBOX)`, `await $$.stubAuths(testOrg)`, and set `$$.fakeConnectionRequest`
   to return the appropriate mock. `chdir` into a temp dir if the command touches the `data-cloud/`
   tree; `$$.restore()` and restore cwd in `afterEach`.
3. **Success path** — assert the returned result shape and the printed output:

   ```ts
   const result = await DataCloudFoo.run([
     '--component',
     'CalculatedInsight:highValueCustomer',
     '--target-org',
     testOrg.username,
   ]);
   expect(result.status).to.equal('SUBMITTED');
   const output = sfCommandStubs.log
     .getCalls()
     .flatMap((c) => c.args)
     .join('\n');
   expect(output).to.include('Deployment submitted for CalculatedInsight:highValueCustomer');
   ```

4. **Error paths** — a missing required flag and a missing org, each asserted on the error message
   (§2). Add one per structured error the command surfaces.
5. **Telemetry** — assert the thin command re-emits nothing (exactly one event from the service
   layer) and `assertAllSafe`, even when flag **values** (a dataspace, an org username) are in scope:

   ```ts
   const events = ourEvents(telemetry);
   expect(events).to.have.lengthOf(1);
   expect(events[0].eventName).to.equal('DATACLOUD_DEVOPS_FOO');
   assertAllSafe(telemetry); // no flag VALUE leaks into the payload
   ```

6. Regenerate the snapshot and schema for the new command and commit them (§8):

   ```bash
   ./bin/dev.js snapshot:generate && ./bin/dev.js schema:generate && yarn build
   ```

Then run `yarn test:only` for the fast loop and `yarn test` before pushing.

---

## Conflicts with project docs

These are places where the **code is the source of truth** and `CLAUDE.md` /
`PROJECT_KNOWLEDGE.md` describe something different:

1. **Coverage threshold.** `.nycrc` (via `@salesforce/dev-config/nyc`) enforces **50%**, not the
   **≥80%** stated in `CLAUDE.md`. 80% is a policy goal, not a locally-enforced gate. Documented in §6
   with the override snippet.
2. **Test framework.** The docs say "JUnit … FIT tests." This JS package uses **mocha + chai + nyc +
   sinon**; NUTs (`@salesforce/cli-plugins-testkit`) are the integration-test mechanism, not FIT.
   JUnit/FIT applies to the Java contract side.
3. **NUT coverage.** Only `test/commands/hello/world.nut.ts` exists. There is **no** `data-cloud`
   NUT and no retrieve→deploy→status FIT test against an orgfarm org yet — that is future work; the
   `data-cloud` commands are covered by fast, offline command tests.
4. **Node version.** `package.json` `engines` requires **`node >=18.0.0`**; `CLAUDE.md` pins **Node
   v24** (and warns v26 breaks the generator). Tests run under any Node ≥18; the v24 pin is a
   toolchain convention, not enforced by the test harness.
5. **Telemetry destination.** Tests assert on the `Lifecycle` telemetry channel and the privacy
   contract; where those events ultimately land (Azure App Insights, per prior investigation — not
   Splunk) is out of scope for the test suite and not asserted.
6. **Endpoint paths.** The commands/services (and the mocks that model their responses) use
   `/ssot/devops/component/snapshot` (retrieve) and `/ssot/devops/component/promotion` (deploy +
   status) — these differ from the older `/retrieve` and `/deploy` paths in the CLAUDE.md summary
   table. `devops-api.test.ts` asserts the current (versioned) paths.
7. **Command count.** `CLAUDE.md` lists "five commands"; the code ships **seven** command files
   (the five Data Cloud commands plus `data-cloud diagnostics` and the `hello world` sample), each
   with its own schema in `schemas/`.
