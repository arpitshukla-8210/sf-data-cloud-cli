# Contributing to `@salesforce/plugin-datacloud-devops`

This guide gets a brand-new contributor from a fresh clone to a merged PR. It is opinionated and
specific to _this_ repo: every command, flag, path, and rule below is drawn from the actual code, not
from generic Salesforce-plugin boilerplate.

**What this plugin is.** `@salesforce/plugin-datacloud-devops` is an internal Salesforce CLI plugin
that brings source-controlled DevOps (retrieve / deploy) to **Data Cloud (Data 360)** components. It
is a **thin client** over Connect API endpoints under `/ssot/devops/*`. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full picture before you write code.

**Scope you are (and are NOT) allowed to touch.** This project owns:

- **Layer 1 — the CLI** (`src/commands/**`, `src/shared/**`).
- **Layer 2 — the Connect API _contracts_** (the TypeScript representation types in `src/shared/types/**`).

It does **NOT** own the Connect API _implementation_, the server-side **spidering** (dependency graph
resolution), or the **DataKit Orchestration Layer** (Layer 3). If a task starts drifting into those,
**stop and flag it** — do not implement it. And never surface DataKit internals (DataKit names,
template names, `&quot;`-encoded XML, internal dependency objects) in CLI output or in files written
to disk. This is enforced deliberately: the on-disk file format carries native JSON `entityPayload`
only ([file-layout.ts](src/shared/types/file-layout.ts)).

The six shipped commands (build target):

| Command                             | What it does                                                  |
| ----------------------------------- | ------------------------------------------------------------- |
| `sf data-cloud component-type list` | List supported Data Cloud component types                     |
| `sf data-cloud component list`      | List components of a type within a dataspace                  |
| `sf data-cloud retrieve`            | Retrieve a component + its dependency graph to `data-cloud/`  |
| `sf data-cloud deploy`              | Deploy a component + transitive deps to a target org          |
| `sf data-cloud deploy status`       | Poll an async deploy job                                      |
| `sf data-cloud diagnostics`         | Bundle local diagnostic logs for support (no org, no network) |

> **Doc note:** `CLAUDE.md` and `PROJECT_KNOWLEDGE.md` describe "the five commands." The code ships
> **six** — the five above plus `data-cloud diagnostics`
> ([diagnostics.ts](src/commands/data-cloud/diagnostics.ts)), added later (commit
> `853fb3d feat(diagnostics)`). There is also a leftover `hello world` scaffold command. Code wins.

---

## 1. Prerequisites

| Tool         | Required version | Why                                                                                                            |
| ------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| **Node.js**  | **v24**          | The oclif plugin generator **crashes on Node v26**. v24 matches the toolchain other Salesforce plugins pin to. |
| **Yarn**     | Classic (v1)     | The **only** supported package manager for this repo (see §2).                                                 |
| **`sf` CLI** | latest           | Provides the `sf` binary this plugin plugs into, plus `sf org login web` for auth.                             |

> **Do not use Node v26.** It crashes the generator used to scaffold new commands and is a documented
> known-issue. Use a version manager (`nvm`, `fnm`, `asdf`) and select v24 before doing anything else:
>
> ```bash
> nvm install 24 && nvm use 24
> node --version   # should print v24.x
> ```

> **Discrepancy to know about (code vs docs):** `package.json` only declares
> [`"engines": { "node": ">=18.0.0" }`](package.json#L23-L25). That floor is _lower_ than the v24 the
> team mandates. The `>=18` in `package.json` will not stop you from running on v26, so the v24 pin is a
> **team convention you must follow manually**, not something the toolchain enforces. **CONFIRM-with-lead**
> whether `engines.node` should be bumped to encode the real requirement.

---

## 2. Setup

### Install dependencies

```bash
yarn install
```

**Never run `npm install`.** This is a hard rule. The repo is Yarn-managed; mixing package managers
will produce a conflicting lockfile and break reproducible builds. If you see a `package-lock.json`
appear, you ran the wrong tool — delete it.

### Build

```bash
yarn build          # tsc compile (src -> lib) + eslint. See package.json wireit "build".
```

`yarn build` is a [wireit](https://github.com/google/wireit) task that runs `compile` then `lint`
([package.json:98-103](package.json#L98-L103)). Compilation emits `src/**/*.ts` into `lib/**`
([tsconfig.json](tsconfig.json), `rootDir: src`, `outDir: lib`).

> This is an **ESM package** (`"type": "module"`, [package.json:213](package.json#L213)). Every
> relative import in source and tests carries a **`.js` extension** even though the file on disk is
> `.ts` — e.g. `import { retrieveComponents } from '../../shared/services/retrieve-service.js';`
> ([retrieve.ts:19](src/commands/data-cloud/retrieve.ts#L19)). This is required, not a typo.

### Run a command locally

Two ways to run the plugin against your working tree:

**Option A — `./bin/dev.js` (no linking, runs TypeScript directly via ts-node):**

```bash
./bin/dev.js data-cloud component-type list --src-org myOrg
./bin/dev.js data-cloud retrieve --component CalculatedInsight:highValueCustomer --dataspace default --src-org myOrg
```

`bin/dev.js` runs the command straight from `src/` — no build step needed, fastest inner loop.

**Option B — link the plugin into your real `sf` install (runs compiled `lib/`):**

```bash
yarn build              # required first: oclif "commands" points at ./lib/commands (package.json:46)
sf plugins link .
sf data-cloud component-type list --src-org myOrg
```

> **Gotcha (linked plugins):** if after linking you see a warning like
> _"X is not a sf command. Did you mean X?"_, do a clean rebuild of `lib/` (`yarn clean && yarn build`)
> and re-link. This happens because `deploy` is both a topic **and** a command (the `deploy/index.ts`
> folder pattern — see §7). A stale `lib/` confuses oclif's taxonomy.

---

## 3. Branch strategy

```
develop  ← integration target
  └── feature/<short-description>   ← your work branches from here
```

- Branch off **`develop`**, using `feature/*` (or `fix/*`, `chore/*`) naming.
- **Never commit directly to `develop` or `main`.** If you find yourself on a default branch, branch first.
- Do **not** commit or push unless the task explicitly asks for it.

> **CONFIRM-with-lead on the integration target.** The project docs name **`develop`** as the confirmed
> integration target and `feature/initial-setup` as the working branch
> ([CLAUDE.md](CLAUDE.md) "Git / workflow"). However, the repo's git metadata reports the **main branch
> as `main`** (not `develop`), and there is a note in the docs to "confirm with Ayush." Before opening
> your first PR, confirm the actual target branch with the lead — the docs and the repo config point at
> different names, and this guide follows the documented `develop` per project convention.

### Commit and PR trailers

When you _are_ asked to commit, end commit messages with:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

and end PR bodies with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## 4. Conventional Commits

Every commit message uses [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`. The `scope` in this repo is typically the subsystem or command touched.

Types actually used in this repo's history: `feat`, `fix`, `chore`, `refactor` (and `test` for
test-only changes). Real examples from `git log`:

```text
feat(retrieve): add file-writing engine with service layer
feat(deploy): implement deploy service layer with file-reader and dependency walk
feat(telemetry): add telemetry instrumentation and refactor deploy structure
feat(diagnostics): add data-cloud diagnostics command and local diagnostic logging
feat(api+telemetry): wire commands to real Connect API and add telemetry
fix(tests): handle Windows path separators and CRLF in tar output
fix(ci): regenerate command snapshot with new flags
fix(review): address PR #5 feedback (C1 test, C2 comment)
refactor(paths): derive component folders at runtime instead of a hardcoded catalog
chore: update command snapshot for new flags
```

Guidelines drawn from that style:

- **Imperative, present tense** summary ("add", "wire", "handle" — not "added"/"adds").
- **Scope names match the subsystem:** `retrieve`, `deploy`, `telemetry`, `diagnostics`, `paths`,
  `api`, `tests`, `ci`, `review`. Compound scopes are fine (`api+telemetry`).
- Reference PR-review rounds with a `fix(review):` prefix when addressing feedback.

---

## 5. Code style

### Language & framework

- **TypeScript** for all command and service code. Strict ESM: `tsconfig.json` extends
  `@salesforce/dev-config/tsconfig-strict-esm` ([tsconfig.json:2](tsconfig.json#L2)).
- **oclif** via `@salesforce/sf-plugins-core` — every command `extends SfCommand<TResult>` and uses the
  `Flags` factories ([retrieve.ts:17](src/commands/data-cloud/retrieve.ts#L17),
  [retrieve.ts:33](src/commands/data-cloud/retrieve.ts#L33)).

### ESLint

Config: [.eslintrc.cjs](.eslintrc.cjs). It extends three shared configs and adds exactly one local rule.

```js
// .eslintrc.cjs:8
extends: ['eslint-config-salesforce-typescript', 'eslint-config-salesforce-license', 'plugin:sf-plugin/recommended'],
```

| Extended config                       | What it enforces                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eslint-config-salesforce-typescript` | The Salesforce TypeScript rule set (strict typing, `no-empty`, `no-unnecessary-condition`, floating-promise checks, etc.).                          |
| `eslint-config-salesforce-license`    | The **Apache-2.0 license-header rule** (`header/header`) — see below.                                                                               |
| `plugin:sf-plugin/recommended`        | The `sf`/oclif command-authoring rules (flag conventions, message-loading conventions, `SfCommand` patterns). Comes from `eslint-plugin-sf-plugin`. |

The single local override ([.eslintrc.cjs:10-13](.eslintrc.cjs#L10-L13)):

```js
rules: {
  // Allow intentionally-unused, underscore-prefixed params (e.g. the deploy mock's _request).
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
},
```

Two lint gotchas you _will_ hit if you touch observability code:

- **`no-empty`:** you cannot write an empty `catch {}`. Telemetry and the diagnostic logger are
  fire-and-forget and swallow their own errors, but the catch body must contain a real statement
  (`return;`) — an empty block or a bare comment fails lint. See
  [telemetry.ts](src/shared/services/telemetry.ts) `emitTelemetry` and
  [logger.ts](src/shared/diagnostics/logger.ts) `write`.
- **`no-unnecessary-condition`:** feature gates that ship disabled are typed `: boolean` (not the literal
  `false`) so the guard stays a _real runtime check_ and isn't narrowed to dead code. Examples:
  `GACK_EXTRACTION_ENABLED: boolean = false` ([telemetry.ts](src/shared/services/telemetry.ts)) and
  `SEND_CORRELATION_HEADER: boolean = false` ([devops-api.ts](src/shared/services/devops-api.ts)). Do
  not "simplify" these to the literal — you will break the design and the lint will complain.

```bash
yarn lint          # eslint src test (cached)
```

### Prettier

Formatting is Prettier-managed via the `format` wireit task. It formats `src`, `test`, `schemas`, **and
`command-snapshot.json`** ([package.json:117-127](package.json#L117-L127)):

```bash
yarn format        # prettier --write over src|test|schemas + command-snapshot.json
```

If CI complains about formatting on a generated file (`command-snapshot.json`, `schemas/*.json`), run
`yarn format` and commit the result — those files are intentionally Prettier-managed.

### Apache-2.0 license header (required on every source file)

Every `.ts` file in `src/` **and** `test/` must open with the 15-line Apache-2.0 header dated
**2026**. It looks exactly like this (from [retrieve.ts:1-15](src/commands/data-cloud/retrieve.ts#L1-L15)):

```ts
/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
```

The header is enforced by the `header/header` rule from `eslint-config-salesforce-license`. If you add a
file and forget it, `yarn lint` fails. Auto-apply/fix headers with:

```bash
yarn fix-license   # eslint src test --fix --rule "header/header: [2]"
```

> **Minor inconsistency, do not copy it:** the ESLint config file itself
> ([.eslintrc.cjs:1-6](.eslintrc.cjs#L1-L6)) still carries a **BSD-3-Clause** header (a scaffold
> artifact). All _product and test_ files are Apache-2.0 and `package.json` declares
> `"license": "Apache-2.0"`. New files you add must use the **Apache-2.0** header above, not BSD.

---

## 6. PR checklist

Run **`yarn test`** before opening a PR. It is a wireit aggregate that runs seven gates — all must pass
([package.json:147-157](package.json#L147-L157)):

```text
test:compile            # type-check the test tree
test:only               # unit tests + coverage (nyc mocha "test/**/*.test.ts")
test:command-reference  # commandreference:generate --erroronwarnings  (fails on ANY message-file gap)
test:deprecation-policy # snapshot:compare  (fails if a command/flag/alias was removed or renamed)
lint                    # eslint src test
test:json-schema        # schema:compare  (fails if a --json return type drifts from schemas/*.json)
link-check              # linkinator over markdown (skipped in CI)
```

Note `test:nuts` (the integration NUTs) is **not** part of `yarn test` — NUTs need a real org and run
separately (`yarn test:nuts`).

Before you request review, confirm each item:

- [ ] **Tests pass:** `yarn test` is green.
- [ ] **Coverage ≥ 80%:** `test:only` runs `nyc`. Thresholds come from the shared
      `@salesforce/dev-config/nyc` preset ([.nycrc](.nycrc)). _Caveat:_ the 80% figure is the team
      target from the docs; the local `.nycrc` inherits whatever the shared preset pins — it does not
      hard-code an 80 locally. Keep new code well-covered regardless.
- [ ] **Command snapshot updated** if you changed any command's surface (added/renamed/removed a
      command, flag, alias, or char). `command-snapshot.json` is a checked-in record of the public
      contract of every command ([command-snapshot.json](command-snapshot.json)). Regenerate it after an
      intentional change:

      ```bash
      yarn build
      ./bin/dev.js snapshot:generate    # rewrites command-snapshot.json
      yarn format                       # prettier-format the regenerated file
      ```

      `test:deprecation-policy` (`snapshot:compare`) will then pass. If you *did not* intend to change a
      command's surface and this test fails, you have an accidental breaking change — fix the code, don't
      regenerate the snapshot.

- [ ] **JSON schema updated** if you changed a command's `--json` return type. Each command's result type
      is codified as a checked-in draft-07 schema under `schemas/` (e.g.
      [schemas/data\_\_cloud-retrieve.json](schemas/data__cloud-retrieve.json), and one exists for every
      command including `data__cloud-diagnostics.json`). `test:json-schema` (`schema:compare`)
      regenerates each schema from the live TS return type and fails on drift. Regenerate with:

      ```bash
      ./bin/dev.js schema:generate      # rewrites schemas/*.json from the TS Result types
      ```

- [ ] **Messages complete.** All human-facing strings live in `messages/*.md` (never inline in `.ts`).
      Every flag needs a `flags.<name>.summary`; commands need `summary`, `description`, `examples`.
      `test:command-reference` runs with `--erroronwarnings` and **fails on any missing message key**.
      See [messages/data-cloud.retrieve.md](messages/data-cloud.retrieve.md) for the exact file format
      (H1 `# key` headers, `%s` positional args, `<%= config.bin %>` / `<%= command.id %>` templates).
- [ ] **No secrets.** No tokens, session IDs, org credentials, or customer data in code, tests,
      fixtures, or committed files. Telemetry and diagnostics are built to make this hard to violate
      (see §7) — do not add fields that carry names, paths, or dataspace names to telemetry events.
- [ ] **Conventional Commit** message (see §4).
- [ ] **No invented endpoints, field names, flags, or component types.** Every wire contract must match
      what already exists in `src/shared/types/**` and the `/ssot/devops/*` paths in
      [devops-api.ts](src/shared/services/devops-api.ts). If a contract detail isn't specified, **ask —
      don't guess.**

---

## 7. Architecture rules contributors MUST follow

These are the non-negotiables. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/ADDING_A_COMMAND.md](docs/ADDING_A_COMMAND.md) before writing a command; this section is the short
version.

> **Doc cross-reference note:** the task brief points to `docs/DESIGN_PRINCIPLES.md`. **That file does
> not exist in this repo.** The design principles below are drawn directly from the code and from the
> docs that _do_ exist: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
> [docs/ADDING_A_COMMAND.md](docs/ADDING_A_COMMAND.md),
> [docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md), and [docs/TELEMETRY.md](docs/TELEMETRY.md).

### 7.1 Thin commands — all logic in the service layer

A command file does exactly this: parse flags → resolve the org connection (if any) → make **one**
`await <service>(...)` call → render human output with `this.log`/`this.table`/`this.warn` → `return`
the result object. **No HTTP, file I/O, dependency walking, or enum normalization in a command file.**

The canonical thin command, verbatim ([retrieve.ts:53-72](src/commands/data-cloud/retrieve.ts#L53-L72)):

```ts
public async run(): Promise<RetrieveResult> {
  const { flags } = await this.parse(DataCloudRetrieve);
  const conn = flags['src-org'].getConnection(flags['api-version']);

  // The service fetches the snapshot, persists each component to disk (§5.2), and returns the
  // standardized result with raw payloads stripped. Writes under process.cwd().
  const result = await retrieveComponents(conn, flags.component, flags.dataspace);

  // Human-readable output (auto-suppressed when --json is present).
  this.log(messages.getMessage('info.success', [result.retrievedComponents.length]));
  for (const comp of result.retrievedComponents) {
    this.log(`  - ${messages.getMessage('info.componentLine', [comp.componentType, comp.componentName])}`);
  }
  this.log('');
  this.log(messages.getMessage('info.filesWritten', [result.fileWriteLocation]));

  // Returned object is what --json emits and what unit tests assert against.
  return result;
}
```

**Why:** the returned object is the `--json` contract _and_ what unit tests assert against. Human output
via `this.log`/`this.table` is auto-suppressed under `--json` by `SfCommand`. Keeping the command thin
means the service layer is the single place with logic to test.

Where the real work lives:

| Command               | Service module                                                           | Service function          |
| --------------------- | ------------------------------------------------------------------------ | ------------------------- |
| `component-type list` | [devops-api.ts](src/shared/services/devops-api.ts)                       | `getComponentTypes`       |
| `component list`      | [devops-api.ts](src/shared/services/devops-api.ts)                       | `getComponents`           |
| `retrieve`            | [retrieve-service.ts](src/shared/services/retrieve-service.ts)           | `retrieveComponents`      |
| `deploy`              | [deploy-service.ts](src/shared/services/deploy-service.ts)               | `deployComponents`        |
| `deploy status`       | [deploy-status-service.ts](src/shared/services/deploy-status-service.ts) | `checkDeployStatus`       |
| `diagnostics`         | [diagnostics-service.ts](src/shared/services/diagnostics-service.ts)     | `collectDiagnosticBundle` |

The only two logic-y bits that _are_ allowed to live in a command (and only these two): the
`component-type list` `Object.entries().map()` reshape, and the `deploy status` **display-only**
`'SUCCESS' → 'SUCCEEDED'` mapping. The returned object always keeps the raw contract value
(`SUCCESS`); only the human text says `SUCCEEDED`
([status.ts](src/commands/data-cloud/deploy/status.ts)).

**The "command that is also a topic" pattern.** `deploy` is both a subtopic and a runnable command. That
is why the deploy command lives at `src/commands/data-cloud/deploy/index.ts` (runnable `sf data-cloud
deploy`) while `sf data-cloud deploy status` lives at `src/commands/data-cloud/deploy/status.ts`. Use the
`folder/index.ts` layout when a command needs subcommands; a clean `lib/` rebuild resolves the linked-plugin
"not a sf command" warning.

### 7.2 Never invent endpoints or field names

The HTTP boundary is a single file: [devops-api.ts](src/shared/services/devops-api.ts). Every function is
one `Connection.request` against a `/ssot/devops/*` path, with the API version resolved from the
connection — **never hardcoded**:

```ts
// devops-api.ts basePath
const basePath = (conn) => `/services/data/v${conn.getApiVersion()}/ssot/devops`;
```

The **actual** endpoint paths in code (these are what services target):

| Command               | Verb + path (code = source of truth)                               |
| --------------------- | ------------------------------------------------------------------ |
| `component-type list` | `GET /ssot/devops/component-types`                                 |
| `component list`      | `GET /ssot/devops/component/catalog?componentType=&dataSpaceName=` |
| `retrieve`            | `GET /ssot/devops/component/snapshot`                              |
| `deploy`              | `POST /ssot/devops/component/promotion`                            |
| `deploy status`       | `GET /ssot/devops/component/promotion/{jobId}`                     |

> **Discrepancy (code vs CLAUDE.md):** `CLAUDE.md`'s command table still lists the _older_ shapes
> (`component-object-api-names`, `POST /ssot/devops/retrieve`, `POST /ssot/devops/deploy`,
> `GET /ssot/devops/deploy/{jobId}/status`). The backend contract drifted to the `/component/*` paths
> above; the code and the type-file headers are authoritative. When adding a call, use the paths in
> [devops-api.ts](src/shared/services/devops-api.ts), and if a new contract detail isn't already in the
> types under `src/shared/types/**`, **ask the backend owner — do not invent it.**

Field names are equally fixed. On-disk and on-the-wire component shapes use exactly these keys, and the
payload key is **`entityPayload`** (never `data`): `componentType`, `componentName`, `dataspaceName`,
`dependsOn[]`, `entityPayload` ([file-layout.ts](src/shared/types/file-layout.ts)). `entityPayload` is
stored **verbatim and never re-parsed** so a component round-trips byte-for-byte from retrieve to deploy.
The deploy POST body wraps the component array as `{ components: [...] }` — that wrapping happens in
`createPromotion`, not in the assembler ([deploy-service.ts](src/shared/services/deploy-service.ts)).

### 7.3 Never surface DataKit internals

No DataKit names, template names, `&quot;`-encoded XML, or internal dependency objects may appear in CLI
output or in any file written to disk. The on-disk format is native JSON only, human-readable and
2-space indented, with deterministic `<componentName>.json` file names in a flat-by-type,
dataspace-aware tree ([file-writer.ts](src/shared/services/file-writer.ts),
[component-paths.ts](src/shared/constants/component-paths.ts)). These design invariants — deterministic
file names, indented JSON, the flat-by-type layout — are the entire point of the project and are
non-negotiable. See [docs/ON_DISK_FORMAT.md](docs/ON_DISK_FORMAT.md).

### 7.4 Observability never throws

Two independent observability channels, and **neither may ever alter a command's return value, output,
or error propagation**:

- **Telemetry** ([telemetry.ts](src/shared/services/telemetry.ts)) — flat primitive attributes emitted on
  the `@salesforce/core` `Lifecycle` telemetry channel. Callers **must** use `void emitTelemetry(...)`
  (fire-and-forget); the function try/catches its own body and returns on failure. Event names follow
  `DATACLOUD_DEVOPS_<VERB>_<NOUN>`. **Safe fields only:** the `TelemetryAttributes` type is
  `Record<string, string | number | boolean>`, which structurally blocks nested objects and raw API
  bodies. Never attach `componentName`, paths, or dataspace names to a telemetry event. (There are
  exactly two deliberate, narrowly-scoped exceptions — an `errorMessage` on error-path events, and the
  customer's own `componentName`/`componentType` on the `DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE`
  sub-event. Do not add a third.) See [docs/TELEMETRY.md](docs/TELEMETRY.md).
- **Local diagnostics** ([logger.ts](src/shared/diagnostics/logger.ts)) — a separate on-disk NDJSON
  channel for debugging a single run. Every write is a synchronous `appendFileSync` wrapped in try/catch;
  any failure is swallowed. All values pass through redaction ([redact.ts](src/shared/diagnostics/redact.ts))
  before hitting disk. See [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md).

When you add instrumentation: emit on both success and failure, spread optional fields conditionally
(`...(orgId && { orgId })`), and re-throw the **original** error unchanged after emitting — never let a
telemetry/diagnostic failure surface to the user.

### 7.5 Errors must be structured and actionable

Never surface a raw gack or "contact support." Throw `SfError` with a machine-parseable **code**, an
actionable **message**, and where relevant the **failing component**. The HTTP boundary maps low-level
failures into four structured codes — `DataCloudApiNetworkError`, `DataCloudApiAuthError`,
`DataCloudApiNotFoundError`, `DataCloudApiError` — in `toSfError`
([devops-api.ts](src/shared/services/devops-api.ts)). The file layer throws
`InvalidComponentTypeError`, `ComponentNotFoundError`, `InvalidComponentFileError`, and
`DependencyNotFoundError`, several with "Run `sf data-cloud retrieve`" guidance
([file-reader.ts](src/shared/services/file-reader.ts),
[component-paths.ts](src/shared/constants/component-paths.ts)). See
[docs/ERROR_HANDLING.md](docs/ERROR_HANDLING.md).

---

## 8. Adding a new command (quick recipe)

Full walkthrough: [docs/ADDING_A_COMMAND.md](docs/ADDING_A_COMMAND.md). The short version:

1. Create the command under `src/commands/data-cloud/<name>.ts` (or `<topic>/<name>.ts`). Copy the
   Apache-2.0 header, extend `SfCommand<TResult>`, load messages with the dotted bundle key.
2. Add the result type to `src/shared/types/<name>.ts`.
3. Put all logic in a `src/shared/services/<name>-service.ts` function; keep the command thin (§7.1).
4. Register the topic/subtopic in [package.json](package.json#L54-L72) if the command introduces one.
5. Add `messages/data-cloud.<dotted-command-path>.md` with `summary`, `description`, `examples`, and a
   `flags.<name>.summary` for every flag.
6. `yarn build` then run it via `./bin/dev.js data-cloud <name>`.
7. Regenerate the snapshot and schema (§6), add unit tests, and run `yarn test`.

---

## Quick reference

```bash
nvm use 24                 # Node v24 — NOT v26
yarn install               # never npm install
yarn build                 # compile + lint
./bin/dev.js data-cloud …  # run locally against src
yarn lint                  # eslint
yarn format                # prettier (incl. command-snapshot.json + schemas)
yarn fix-license           # re-apply Apache-2.0 headers
yarn test                  # full PR gate (7 checks)
yarn test:nuts             # integration NUTs (need a real org; separate)
```
