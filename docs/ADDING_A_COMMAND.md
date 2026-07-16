# Adding a New CLI Command

A concrete, ordered how-to for adding a new command to `@salesforce/plugin-datacloud-devops`.
It uses the existing **`sf data-cloud retrieve`** command as the worked reference throughout, and
cites the exact file + lines you should copy from. Follow the steps in order; the final section is a
pre-PR checklist.

> **Scope note (read the hard rules first).** This plugin is a **thin client** over the Data Cloud
> DevOps Connect API. You own **Layer 1 (the CLI)** and **Layer 2 (the Connect API contract types)**.
> You do **not** own the Connect API implementation, spidering, or the DataKit Orchestration Layer.
> Never invent endpoints, field names, flags, component types, or event names, and never surface
> DataKit internals (names, template names, encoded XML) in command output or on-disk files. See
> [CLAUDE.md](../CLAUDE.md) and `PROJECT_KNOWLEDGE.md` §1, §5.

---

## The layered anatomy of a command

Every command in this repo is built from the same five layers. Each new command touches the same
files in the same order. `retrieve` is the canonical example:

```
                        sf data-cloud retrieve --component ... --dataspace ... --src-org ...
                                                    │
  Layer 1  Command   src/commands/data-cloud/retrieve.ts          parse flags → resolve conn → 1 service call → render
                                                    │
  i18n     Messages  messages/data-cloud.retrieve.md              summary / description / examples / flags.* / info.*
                                                    │
  Layer    Service   src/shared/services/retrieve-service.ts      correlationId + telemetry + diag; orchestrates the work
                                                    │
  Types    Contract  src/shared/types/retrieve.ts                 request/response/result interfaces (the Layer 2 contract)
                                                    │
  Layer    HTTP      src/shared/services/devops-api.ts            the ONE Connection.request boundary; toSfError mapping
                                                    │
                                            GET /ssot/devops/component/snapshot
```

The command file is deliberately dumb: it parses flags, resolves a `Connection`, makes **one**
`await <service>(...)` call, prints human output with `this.log`/`this.table`, and `return`s the
result object (which is what `--json` and the unit tests consume). All HTTP, file I/O, and telemetry
live below it. Keep that separation — it is what keeps the command testable and the surface thin.

The six commands that exist today (code is the source of truth — this is **six**, not the five listed
in CLAUDE.md, because `diagnostics` was added later):

| Command                             | Endpoint                                       | Reference command file                                                        |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `sf data-cloud component-type list` | `GET /ssot/devops/component-types`             | [`component-type/list.ts`](../src/commands/data-cloud/component-type/list.ts) |
| `sf data-cloud component list`      | `GET /ssot/devops/component/catalog`           | [`component/list.ts`](../src/commands/data-cloud/component/list.ts)           |
| `sf data-cloud retrieve`            | `GET /ssot/devops/component/snapshot`          | [`retrieve.ts`](../src/commands/data-cloud/retrieve.ts)                       |
| `sf data-cloud deploy`              | `POST /ssot/devops/component/promotion`        | [`deploy/index.ts`](../src/commands/data-cloud/deploy/index.ts)               |
| `sf data-cloud deploy status`       | `GET /ssot/devops/component/promotion/{jobId}` | [`deploy/status.ts`](../src/commands/data-cloud/deploy/status.ts)             |
| `sf data-cloud diagnostics`         | _(local only — no endpoint)_                   | [`diagnostics.ts`](../src/commands/data-cloud/diagnostics.ts)                 |

> These `/ssot/devops/component/*` paths are what the code actually calls
> ([`devops-api.ts:45`](../src/shared/services/devops-api.ts#L45) builds `basePath`, and the endpoint
> paths appear at [L147](../src/shared/services/devops-api.ts#L147), [L222](../src/shared/services/devops-api.ts#L222),
> [L300](../src/shared/services/devops-api.ts#L300), [L355](../src/shared/services/devops-api.ts#L355),
> [L402](../src/shared/services/devops-api.ts#L402)). They differ from the shorter paths named in
> CLAUDE.md (`component-object-api-names`, `retrieve`, `deploy`, `deploy/{jobId}/status`). **Follow the
> code.** If your new command maps to an endpoint, confirm the exact path with the backend owner and
> put the real path in `devops-api.ts` — do not invent one.

---

## Step 1 — Decide where the command file lives

Commands are discovered by oclif from `./lib/commands` (compiled output of `src/commands`), configured
at [`package.json:46`](../package.json#L46). The topic separator is a **space**
([`package.json:48`](../package.json#L48)), so the _folder path under `src/commands` becomes the
command name_:

```
src/commands/data-cloud/retrieve.ts           →  sf data-cloud retrieve
src/commands/data-cloud/component/list.ts     →  sf data-cloud component list
src/commands/data-cloud/deploy/status.ts      →  sf data-cloud deploy status
```

Rules:

- **A verb under a topic** → `src/commands/data-cloud/<verb>.ts` (like `retrieve.ts`).
- **A verb under a subtopic** → `src/commands/data-cloud/<subtopic>/<verb>.ts` (like `component/list.ts`).
- **A command that is ALSO a topic** (i.e. `sf data-cloud deploy` runs, _and_ `sf data-cloud deploy status`
  also exists) → put the runnable command in an **`index.ts`** inside the folder:
  `src/commands/data-cloud/deploy/index.ts` is `sf data-cloud deploy`, and
  `src/commands/data-cloud/deploy/status.ts` is `sf data-cloud deploy status`. See
  [`deploy/index.ts`](../src/commands/data-cloud/deploy/index.ts). Using `index.ts` (instead of
  `deploy.ts` alongside a `deploy/` folder) is what avoids oclif's _"deploy is not a sf command. Did
  you mean deploy?"_ warning on a linked plugin — the folder and the command resolve to one node.

For a brand-new verb `foo` under the `data-cloud` topic, create:

```
src/commands/data-cloud/foo.ts
```

Every source file must begin with the Apache 2.0 license header (see
[`retrieve.ts:1-15`](../src/commands/data-cloud/retrieve.ts#L1-L15)) — `yarn build`'s lint step
enforces it, and `yarn fix-license` can add it.

---

## Step 2 — Write the oclif command class

Copy the structure of [`retrieve.ts`](../src/commands/data-cloud/retrieve.ts) exactly. The important
parts, with line citations:

- **Imports** — `SfCommand`, `Flags` from `@salesforce/sf-plugins-core`; `Messages` from
  `@salesforce/core`; your service; your result type
  ([`retrieve.ts:17-20`](../src/commands/data-cloud/retrieve.ts#L17-L20)). This is an ESM package
  (`"type": "module"`, [`package.json:213`](../package.json#L213)) so **every relative import ends in
  `.js`** even though the source is `.ts`.
- **Load messages once, at module scope**
  ([`retrieve.ts:22-23`](../src/commands/data-cloud/retrieve.ts#L22-L23)).
- **Extend `SfCommand<YourResult>`** so the generic pins the `--json`/return type
  ([`retrieve.ts:33`](../src/commands/data-cloud/retrieve.ts#L33)).
- **`static summary` / `description` / `examples`** pulled from messages
  ([`retrieve.ts:34-36`](../src/commands/data-cloud/retrieve.ts#L34-L36)). Note `examples` uses
  `getMessages` (plural).
- **`static flags`** ([`retrieve.ts:38-51`](../src/commands/data-cloud/retrieve.ts#L38-L51)). Use
  `Flags.requiredOrg({...})` for the org and `Flags.orgApiVersion()` for the version — do not hand-roll
  these. `retrieve` names its org flag `src-org` with `aliases: ['target-org']`
  ([L46-49](../src/commands/data-cloud/retrieve.ts#L46-L49)); `deploy` uses `target-org` with no alias
  ([`deploy/index.ts:48-50`](../src/commands/data-cloud/deploy/index.ts#L48-L50)). Read commands use
  `src-org`; deploy/write commands use `target-org`. Pick per the semantics of your command.
- **`async run()`** ([`retrieve.ts:53-72`](../src/commands/data-cloud/retrieve.ts#L53-L72)):
  1. `const { flags } = await this.parse(YourCommand);` ([L54](../src/commands/data-cloud/retrieve.ts#L54))
  2. `const conn = flags['src-org'].getConnection(flags['api-version']);` ([L55](../src/commands/data-cloud/retrieve.ts#L55))
  3. **One** `await` into the service ([L59](../src/commands/data-cloud/retrieve.ts#L59)).
  4. Human output via `this.log(...)` ([L62-68](../src/commands/data-cloud/retrieve.ts#L62-L68)) — auto-suppressed under `--json`.
  5. `return result;` ([L71](../src/commands/data-cloud/retrieve.ts#L71)).

Minimal template for `src/commands/data-cloud/foo.ts`:

```ts
/*
 * Copyright 2026, Salesforce, Inc.
 * ... Apache 2.0 header (copy verbatim from retrieve.ts:1-15) ...
 */

import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { fooComponents } from '../../shared/services/foo-service.js';
import { FooResult } from '../../shared/types/foo.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.foo');

/*
 * Command: sf data-cloud foo
 * Maps to <VERB> /ssot/devops/<real-path-confirmed-with-backend>.
 * Resolves --src-org to a connection and delegates to the foo service. Stays thin — all HTTP and
 * persistence live in shared/services.
 */
export default class DataCloudFoo extends SfCommand<FooResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    component: Flags.string({
      summary: messages.getMessage('flags.component.summary'),
      required: true,
    }),
    dataspace: Flags.string({
      summary: messages.getMessage('flags.dataspace.summary'),
    }),
    'src-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.src-org.summary'),
      aliases: ['target-org'],
    }),
    'api-version': Flags.orgApiVersion(),
  };

  public async run(): Promise<FooResult> {
    const { flags } = await this.parse(DataCloudFoo);
    const conn = flags['src-org'].getConnection(flags['api-version']);

    // The service does all the work (HTTP + persistence + telemetry) and returns the standardized result.
    const result = await fooComponents(conn, flags.component, flags.dataspace);

    // Human-readable output (auto-suppressed when --json is present).
    this.log(messages.getMessage('info.success', [result.retrievedComponents.length]));

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
```

> Do **not** put HTTP calls, `fs` writes, or `emitTelemetry` in the command file. The reference
> commands prove the rule: `retrieve` delegates to `retrieveComponents`
> ([L59](../src/commands/data-cloud/retrieve.ts#L59)), and even `component list` — which has no
> dedicated service — still calls the HTTP boundary `getComponents` from `devops-api`
> ([`component/list.ts:64`](../src/commands/data-cloud/component/list.ts#L64)) rather than opening its
> own request. For tabular output, `component list` shows the `this.table({ data, columns })` pattern
> ([`component/list.ts:67-70`](../src/commands/data-cloud/component/list.ts#L67-L70)).

---

## Step 3 — Wire up the messages file

Command text is externalized to a Markdown message bundle, loaded via
`Messages.loadMessages('@salesforce/plugin-datacloud-devops', '<bundle-key>')`. **The bundle key is the
command path with dots**, and the file name matches it:

| Command                     | Bundle key & file                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `data-cloud retrieve`       | [`messages/data-cloud.retrieve.md`](../messages/data-cloud.retrieve.md)             |
| `data-cloud component list` | [`messages/data-cloud.component.list.md`](../messages/data-cloud.component.list.md) |
| `data-cloud deploy status`  | [`messages/data-cloud.deploy.status.md`](../messages/data-cloud.deploy.status.md)   |

For `sf data-cloud foo`, create **`messages/data-cloud.foo.md`**.

The format is one `# key` H1 header followed by the value body, until the next H1. See the full
reference [`data-cloud.retrieve.md`](../messages/data-cloud.retrieve.md). Required keys mirror what the
command reads:

- `summary` — one line ([retrieve.md:1-3](../messages/data-cloud.retrieve.md#L1-L3)).
- `description` — a paragraph ([L5-7](../messages/data-cloud.retrieve.md#L5-L7)).
- `flags.<flag>.summary` — one per flag your command declares
  ([L9-20](../messages/data-cloud.retrieve.md#L9-L20)). The key must match the flag name exactly
  (e.g. `flags.src-org.summary`).
- `examples` — a list; use the `<%= config.bin %>` and `<%= command.id %>` tokens so the rendered help
  shows the right binary and command ([L21-25](../messages/data-cloud.retrieve.md#L21-L25)).
- Any human-output strings your `run()` prints, keyed as you like — `retrieve` uses `info.success`,
  `info.componentLine`, `info.filesWritten` ([L27-37](../messages/data-cloud.retrieve.md#L27-L37)) with
  `%s` positional substitutions filled by the array you pass to `getMessage(key, [args])`.

> **Loader gotcha:** the message loader strips a leading `- ` from a value. `retrieve` renders its list
> bullet in code (`` `  - ${...}` `` at [retrieve.ts:65](../src/commands/data-cloud/retrieve.ts#L65))
> precisely because the `.md` value cannot carry the bullet itself. If you want list bullets in output,
> add them in the command, not the message.
>
> For error strings your **service** throws, prefer building `SfError`s in the service/`devops-api`
> layer (see Steps 4 & 6) rather than a message key, matching the existing structured-error pattern.

---

## Step 4 — Create the service (the orchestrator)

Unless your command is a single passthrough to one `devops-api` function (like `component list`), add a
service under `src/shared/services/<name>-service.ts`. This is where the orchestration + observability
lives. Copy [`retrieve-service.ts`](../src/shared/services/retrieve-service.ts) — it is the template.

Structure, in order (all line refs are `retrieve-service.ts`):

1. Apache header, then imports of `randomUUID`, `Connection`/`SfError`, your result type, the diag
   logger + `Subsystem`, the `devops-api` function(s), and the telemetry helpers
   ([L17-25](../src/shared/services/retrieve-service.ts#L17-L25)).
2. `/* eslint-disable camelcase */` at file top **only if** you emit the local-diagnostic `extra` keys,
   which use snake_case by design to match the on-disk NDJSON log schema
   ([L27-33](../src/shared/services/retrieve-service.ts#L27-L33)).
3. Exported async function `fooComponents(conn, ...args, options?)`
   ([L52-57](../src/shared/services/retrieve-service.ts#L52-L57)). Accept an `options?: { baseDir?: string }`
   if you write files, so tests can redirect I/O to a temp dir
   ([L56](../src/shared/services/retrieve-service.ts#L56)).
4. **Before the try:** capture `startedAt = Date.now()`
   ([L60](../src/shared/services/retrieve-service.ts#L60)); mint `correlationId = randomUUID()`
   ([L63](../src/shared/services/retrieve-service.ts#L63)); open the local diagnostic channel
   `diag = getDiagLogger().begin({ command: 'data-cloud foo', correlationId })`
   ([L66](../src/shared/services/retrieve-service.ts#L66)); resolve `orgId = safeOrgId(conn)`
   ([L69](../src/shared/services/retrieve-service.ts#L69)); seed `let componentType = 'unknown'`
   ([L70](../src/shared/services/retrieve-service.ts#L70)).
5. **In the try:** do the work — parse the flag with `parseComponentFlag`
   ([L74](../src/shared/services/retrieve-service.ts#L74), imported from `deploy-service`,
   [L23](../src/shared/services/retrieve-service.ts#L23)), bound the type with `safeComponentType`
   ([L75](../src/shared/services/retrieve-service.ts#L75)), call the `devops-api` function
   ([L84](../src/shared/services/retrieve-service.ts#L84)), persist if applicable
   ([L90](../src/shared/services/retrieve-service.ts#L90)), and assemble the standardized result — with
   raw payloads stripped ([L93-106](../src/shared/services/retrieve-service.ts#L93-L106)).
6. **On success:** `void emitTelemetry('DATACLOUD_DEVOPS_FOO_COMPONENT', { correlationId, componentType, ...(orgId && { orgId }), success: true, ...metrics, durationMs: Date.now() - startedAt })`
   ([L109-118](../src/shared/services/retrieve-service.ts#L109-L118)). The `void` keeps telemetry off the
   latency path; the helper never throws. Then `return result;`
   ([L125](../src/shared/services/retrieve-service.ts#L125)).
7. **In the catch:** derive `errorMessage = errorMessageFrom(err)`
   ([L127](../src/shared/services/retrieve-service.ts#L127)); emit the **failure** telemetry event with
   `success: false` and `errorCode: err instanceof SfError ? err.code : 'UnexpectedError'`
   ([L129-141](../src/shared/services/retrieve-service.ts#L129-L141)); log the diag error
   ([L142-148](../src/shared/services/retrieve-service.ts#L142-L148)); then
   **`throw err;`** — re-throw the **original** error so propagation is unchanged
   ([L149](../src/shared/services/retrieve-service.ts#L149)).

Non-negotiable telemetry rules (proven by tests, Step 8):

- **One event per operation**, success _and_ failure — the command emits nothing itself.
- **Event names** are `DATACLOUD_DEVOPS_<VERB>_<NOUN>` (`retrieve` uses `DATACLOUD_DEVOPS_RETRIEVE_COMPONENT`,
  [L109](../src/shared/services/retrieve-service.ts#L109)). Do not invent a new naming scheme.
- **Never put raw values in telemetry.** Use `safeComponentType` (folds unknown/free-text to `'other'`),
  `safeOrgId`, and `errorMessageFrom`. Never emit the component _name_, dataspace value, file paths, or
  org username. The `assertAllSafe` test enforces this.
- `emitTelemetry` already injects `surface: 'cli'` and lands events in **Azure App Insights**, not
  Splunk (see MEMORY: _Telemetry → Splunk/AppInsights reality_). Do not add a Splunk path.
- `extractGackId` / the correlation request header are wired but currently **disabled**
  (`SEND_CORRELATION_HEADER = false`, [`devops-api.ts:58`](../src/shared/services/devops-api.ts#L58)) —
  leave them as-is unless the backend contract is confirmed.

`deploy-service` is a second example of the same shape if your command reads local files and walks
dependencies ([`deploy-service.ts:47-59`](../src/shared/services/deploy-service.ts#L47-L59) exports the
shared `parseComponentFlag`).

---

## Step 5 — Add the types (the Layer 2 contract)

Add `src/shared/types/foo.ts`. This is a contract you _do_ own, so model it exactly against what the
backend returns — never guess fields. Mirror [`types/retrieve.ts`](../src/shared/types/retrieve.ts):

- **Dependency / row types** ([retrieve.ts:27-33](../src/shared/types/retrieve.ts#L27-L33)).
- **The standardized (payload-stripped) info type** returned in the result
  ([L36-45](../src/shared/types/retrieve.ts#L36-L45)).
- **The result type** your command's generic uses — the shape `--json` emits
  ([`RetrieveResult`, L48-61](../src/shared/types/retrieve.ts#L48-L61)).
- **The raw API response type(s)** the `devops-api` function returns, _including_ the raw
  `entityPayload: Record<string, unknown>` that the service strips before returning
  ([`RawRetrievedComponent` L70-81](../src/shared/types/retrieve.ts#L70-L81) and
  [`RetrieveApiResponse` L84-87](../src/shared/types/retrieve.ts#L84-L87)).

Key invariant: **the raw `entityPayload` never appears in the result type** — it is written to disk
verbatim and stripped from what the command returns (comment at
[retrieve.ts service, L92-98](../src/shared/services/retrieve-service.ts#L92-L98)). This is how the CLI
avoids surfacing DataKit internals. Document each field with a JSDoc comment (the schema tool reads
them in Step 7). File-naming, folder, and dataspace layout for anything written to disk follow
PROJECT_KNOWLEDGE.md §5 — do not change those invariants.

---

## Step 6 — Add the API call in `devops-api.ts`

[`devops-api.ts`](../src/shared/services/devops-api.ts) is the **single HTTP boundary**. Every function
here is one `conn.request(...)` against `/ssot/devops/*`, with the API version resolved from the
connection, never hardcoded. Add a new exported function modeled on `getSnapshot`
([L274-323](../src/shared/services/devops-api.ts#L274-L323)):

1. Build the URL from `basePath(conn)` ([L45](../src/shared/services/devops-api.ts#L45)) plus your
   confirmed endpoint path and query string. For GETs, wrap the URL with `getRequest(url, correlationId)`
   ([L76-81](../src/shared/services/devops-api.ts#L76-L81), used at
   [L300](../src/shared/services/devops-api.ts#L300)). For POSTs, pass a full request object with
   `method`, `url`, `JSON.stringify(body)`, and `headers: { 'Content-Type': 'application/json', ...correlationHeaders(correlationId) }`
   (see `createPromotion`, [L353-359](../src/shared/services/devops-api.ts#L353-L359)).
2. Omit optional query params entirely when absent — never send `dataSpaceName=undefined`
   ([L288-292](../src/shared/services/devops-api.ts#L288-L292)).
3. Wrap the request in `try/catch`; on error, `const mapped = toSfError(err, '<human phrase>');` then
   `throw mapped;` ([L310-322](../src/shared/services/devops-api.ts#L310-L322)). `toSfError`
   ([L89-127](../src/shared/services/devops-api.ts#L89-L127)) maps low-level failures to the four
   structured codes — `DataCloudApiNetworkError`, `DataCloudApiAuthError`, `DataCloudApiNotFoundError`,
   `DataCloudApiError` — each with an actionable action list. This is what satisfies the "errors must
   be structured and actionable, never raw gacks" rule.
4. **Telemetry placement:** the _read-list_ functions (`getComponentTypes`
   [L150-157](../src/shared/services/devops-api.ts#L150-L157), `getComponents`
   [L224-232](../src/shared/services/devops-api.ts#L224-L232)) emit their own
   `DATACLOUD_DEVOPS_API_REQUEST` event. But the functions that back a service (`getSnapshot`,
   `createPromotion`, `getPromotionStatus`) emit **no telemetry** — the orchestration event is emitted
   by the service (Step 4) so there is exactly one event per operation
   (comment at [L328-329](../src/shared/services/devops-api.ts#L328-L329)). Match whichever pattern fits:
   if you added a service in Step 4, do **not** emit telemetry here.

> Confirm the real endpoint path, verb, query params, and response shape with the backend owner before
> writing this function. Do not invent any of them.

---

## Step 7 — Register the JSON schema

Each command's result type gets a JSON Schema under `schemas/`, validated in CI by
`schema:compare`. The file name is the command path with **double-underscore** replacing the topic
separator:

| Command                          | Schema file                                                                 |
| -------------------------------- | --------------------------------------------------------------------------- |
| `data-cloud retrieve`            | [`schemas/data__cloud-retrieve.json`](../schemas/data__cloud-retrieve.json) |
| `data-cloud component list`      | `schemas/data__cloud-component-list.json`                                   |
| `data-cloud component-type list` | `schemas/data__cloud-component__type-list.json`                             |
| `data-cloud deploy status`       | `schemas/data__cloud-deploy-status.json`                                    |

For `sf data-cloud foo`, the schema is **`schemas/data__cloud-foo.json`**.

The schema is JSON Schema **draft-07**, with a top-level `$ref` to your result type and a `definitions`
block mirroring your TypeScript types 1:1. Every object needs a `required` array and
`"additionalProperties": false`. See [`data__cloud-retrieve.json`](../schemas/data__cloud-retrieve.json)
in full — `RetrieveResult` ([L5-31](../schemas/data__cloud-retrieve.json#L5-L31)),
`RetrievedComponentInfo` ([L32-58](../schemas/data__cloud-retrieve.json#L32-L58)),
`ComponentDependency` ([L59-74](../schemas/data__cloud-retrieve.json#L59-L74)).

Generate/validate with the wireit `test:json-schema` target
([`package.json:194-201`](../package.json#L194-L201)), which runs `./bin/dev.js schema:compare`. Run it
locally and commit the generated file so it stays in lockstep with your result type:

```bash
./bin/dev.js schema:compare        # reports drift; regenerates the schema file
yarn test                          # runs it as part of the graph (package.json:154)
```

---

## Step 8 — Write the tests (≥80% coverage)

Tests mirror the `src/` tree under `test/`. Add both a **command test** and (if you added a service) a
**service test**. Coverage inherits `@salesforce/dev-config`'s nyc config via `test:only`
([`package.json:158-171`](../package.json#L158-L171)); the target is **≥80%** on the CLI + contract
code (CLAUDE.md). Cover the success path and **every error path**.

**Command test** — model on
[`test/commands/data-cloud/retrieve.test.ts`](../test/commands/data-cloud/retrieve.test.ts):

- `const $$ = new TestContext();` and `new MockTestOrgData();`
  ([L34-35](../test/commands/data-cloud/retrieve.test.ts#L34-L35)).
- In `beforeEach`: `stubSfCommandUx($$.SANDBOX)` to capture `this.log`/`this.table`
  ([L44](../test/commands/data-cloud/retrieve.test.ts#L44)); `captureTelemetry(telemetry)`
  ([L46](../test/commands/data-cloud/retrieve.test.ts#L46)); `await $$.stubAuths(testOrg)`
  ([L47](../test/commands/data-cloud/retrieve.test.ts#L47)); set `$$.fakeConnectionRequest` to return a
  mock keyed on the request URL ([L50-54](../test/commands/data-cloud/retrieve.test.ts#L50-L54)); if the
  command writes files, `process.chdir` into a `mkdtempSync` temp dir
  ([L55-57](../test/commands/data-cloud/retrieve.test.ts#L55-L57)).
- In `afterEach`: restore cwd **first**, then `resetTelemetry()`, `$$.restore()`, and `rmSync` the temp
  dir ([L60-66](../test/commands/data-cloud/retrieve.test.ts#L60-L66)).
- Invoke via `await DataCloudFoo.run([...])` and assert the returned result shape, the printed output
  (via `sfCommandStubs.log.getCalls()`), and required-flag / missing-org failures
  ([L68-139](../test/commands/data-cloud/retrieve.test.ts#L68-L139)). A required-flag failure surfaces
  as `Missing required flag <name>` ([L127](../test/commands/data-cloud/retrieve.test.ts#L127)).
- Assert **exactly one** telemetry event and that the command adds none of its own
  ([L141-158](../test/commands/data-cloud/retrieve.test.ts#L141-L158)).

**Service test** — model on
[`test/shared/services/retrieve-service.test.ts`](../test/shared/services/retrieve-service.test.ts):

- Build a fake `Connection` with `getApiVersion`, `getAuthInfoFields` (for `safeOrgId`), and a `request`
  that returns your mock ([L37-43](../test/shared/services/retrieve-service.test.ts#L37-L43)).
- Use the shared telemetry harness `captureTelemetry`/`resetTelemetry`/`ourEvents`/`assertAllSafe`/`UUID_RE`
  from [`test/shared/telemetry-test-utils.ts`](../test/shared/telemetry-test-utils.ts)
  ([imported L23-30](../test/shared/services/retrieve-service.test.ts#L23-L30)).
- Cover: standardized result + on-disk files written under `baseDir`
  ([L60-83](../test/shared/services/retrieve-service.test.ts#L60-L83)); routing/edge cases
  ([L85-117](../test/shared/services/retrieve-service.test.ts#L85-L117)); the malformed-flag throw
  (`InvalidComponentFlagError`, [L119-126](../test/shared/services/retrieve-service.test.ts#L119-L126));
  the **telemetry** success event with graph size + duration
  ([L129-154](../test/shared/services/retrieve-service.test.ts#L129-L154)); the free-text type folding to
  `'other'` ([L156-166](../test/shared/services/retrieve-service.test.ts#L156-L166)); the failure event
  carrying `errorCode` + `errorMessage` while re-throwing the original error
  ([L168-191](../test/shared/services/retrieve-service.test.ts#L168-L191)); and that a throwing telemetry
  listener never breaks the operation ([L193-202](../test/shared/services/retrieve-service.test.ts#L193-L202)).

Run with `yarn test` (full graph) or `yarn test:only` (just mocha) during iteration.

---

## Step 9 — Update the command snapshot

`snapshot:compare` enforces the deprecation policy: a snapshot of every command's id, flags, flag
chars, and aliases is checked into [`command-snapshot.json`](../command-snapshot.json). Adding a new
command (or changing its flags) makes `test:deprecation-policy`
([`package.json:184-193`](../package.json#L184-L193)) fail until the snapshot is regenerated.

Regenerate after `yarn build` (it depends on `compile`, [L190-192](../package.json#L190-L192)):

```bash
yarn build
./bin/dev.js snapshot:compare        # add --dryrun to preview; it rewrites command-snapshot.json
```

Your new command should appear as an object like the existing entries — e.g. the `retrieve` entry:

```json
{
  "alias": [],
  "command": "data-cloud:retrieve",
  "flagAliases": ["target-org"],
  "flagChars": ["o"],
  "flags": ["api-version", "component", "dataspace", "flags-dir", "json", "src-org"],
  "plugin": "@salesforce/plugin-datacloud-devops"
}
```

Note the command id uses **colons** in this file (`data-cloud:retrieve`), and `flags` includes the
inherited `flags-dir` and `json`. Commit the regenerated file.

---

## Step 10 — Register the topic / subtopic in `package.json`

oclif needs a description for every topic and subtopic so help renders correctly. If your command
introduces a **new** topic or subtopic, add it under `oclif.topics`
([`package.json:54-72`](../package.json#L54-L72)). Existing subtopics of `data-cloud` are
`component-type`, `component`, and `deploy` ([L60-70](../package.json#L60-L70)).

- Adding a verb under an existing topic (e.g. `data-cloud foo`) needs **no** change here — `data-cloud`
  is already registered ([L58-59](../package.json#L58-L59)).
- Adding a verb under a **new subtopic** (e.g. `data-cloud bar baz`) requires a new entry:

```jsonc
"data-cloud": {
  "description": "Source-controlled DevOps (retrieve and deploy) for Data Cloud (Data 360) components.",
  "subtopics": {
    // ...existing...
    "bar": { "description": "One-line description of the bar subtopic." }
  }
}
```

`flexibleTaxonomy: true` ([L73](../package.json#L73)) lets users invoke the command with either
`sf data-cloud bar baz` or the flexible form, but the topic description is still required.

---

## Pre-PR checklist

Run everything below and confirm each item before opening the PR. Use **Yarn only** — never
`npm install`. Node **v24** (v26 crashes the plugin generator; `package.json` `engines` says
`>=18.0.0` but match the team toolchain at v24).

- [ ] **Builds clean:** `yarn build` (compile + lint) passes — includes the license-header rule.
- [ ] **Lint clean:** `yarn lint` passes (or is covered by `yarn build`).
- [ ] **Tests pass:** `yarn test` — includes `test:only`, `test:command-reference`,
      `test:deprecation-policy`, `test:json-schema`, and `link-check`
      ([`package.json:147-157`](../package.json#L147-L157)).
- [ ] **Coverage ≥80%** on the new command, service, and contract types; success **and** every error
      path is tested.
- [ ] **Command file is thin:** parses flags → resolves `Connection` → one service call → renders →
      returns. No HTTP, `fs`, or `emitTelemetry` in the command.
- [ ] **Messages complete:** `messages/data-cloud.<path>.md` has `summary`, `description`, `examples`
      (with `<%= config.bin %>`/`<%= command.id %>`), and a `flags.<flag>.summary` for every flag.
- [ ] **Schema updated:** `./bin/dev.js schema:compare` reports no drift; `schemas/data__cloud-<path>.json`
      committed and matches the result type (draft-07, `required` + `additionalProperties: false`).
- [ ] **Snapshot updated:** `./bin/dev.js snapshot:compare` clean; `command-snapshot.json` committed.
- [ ] **Topic/subtopic registered** in `package.json` `oclif.topics` if new.
- [ ] **Telemetry:** exactly one `DATACLOUD_DEVOPS_<VERB>_<NOUN>` event per operation (success + failure),
      all attributes safe (`safeComponentType`/`safeOrgId`/`errorMessageFrom`), no raw names/paths/orgs;
      `assertAllSafe` passes.
- [ ] **Errors structured & actionable:** every failure path returns an `SfError` with a code, message,
      and action (via `toSfError` or an explicit `SfError`) — no raw gacks, no "contact support".
- [ ] **No invented contracts:** endpoints, verbs, field names, flags, env vars, event names, and
      component types all trace to real code or a backend-confirmed contract.
- [ ] **No DataKit internals** in output or on-disk files (no DataKit names, template names, encoded XML).
- [ ] **Stayed in scope:** CLI (Layer 1) and contract types (Layer 2) only — nothing in the Connect API
      implementation, spidering, or DataKit Orchestration Layer.
- [ ] **Conventional Commit** message (e.g. `feat(foo): add sf data-cloud foo command`). Branch off the
      integration branch; do not push to a default branch.

```

```
