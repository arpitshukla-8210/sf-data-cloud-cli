# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in `@salesforce/plugin-datacloud-devops`.

This file is a **router**, not an encyclopedia. It gives you (1) the rules you must never break, (2) a
table telling you exactly which doc/source to read for the task in front of you, and (3) the commands
to run. Read the linked doc **before** planning or writing code for that area — the docs are verified
against the source and are the fast path to correct changes.

> **Source-of-truth order:** the **code** wins over every doc. Where a doc disagrees with the code,
> follow the code and flag the drift. Among docs: [`docs/`](docs/) (verified against source) is
> authoritative for _how the code works today_; [`PROJECT_KNOWLEDGE.md`](PROJECT_KNOWLEDGE.md) is
> authoritative for _scope, business context, contracts, and the plan_. If those two conflict on a
> current-behavior fact, the code + `docs/` win — and tell me.

---

## What this project is (one paragraph)

An internal Salesforce CLI plugin that brings source-controlled DevOps (**retrieve / deploy**) to
**Data Cloud (Data 360)** components, at parity with core `sf project retrieve/deploy`. The CLI is a
**thin client** over a handful of **Connect API** endpoints under `/ssot/devops/*`; all heavy lifting
(dependency spidering, DataKit orchestration) lives server-side and is **not ours**. Owned by Arpit
Shukla (intern); a separate developer owns the server-side implementation.

---

## 🚦 Hard rules — never violate

1. **Stay in scope.** We own the **CLI** (Layer 1) and the **Connect API _contracts_** (Layer 2 representation classes). We do **NOT** own the Connect API _implementation_, **spidering**, or the **DataKit Orchestration Layer** (Layer 3). If a task drifts there, **stop and flag it**.
2. **Never invent** endpoints, field names, component types, or file shapes. Use the exact contracts in the code / [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md). If it isn't specified, ask — don't guess.
3. **Never surface DataKit internals** — no DataKit names, template names, `&quot;`-encoded XML, or internal dependency objects in CLI output, telemetry, or files on disk.
4. **Observability never throws.** Telemetry (`emitTelemetry`) and diagnostics (`DiagLogger`) are fire-and-forget: they swallow their own errors. Callers use `void` for telemetry. A logging failure must never break a command.
5. **Errors are structured and actionable** — every error is an `SfError` with a machine-parseable `code`, a human-readable `message`, and remediation `actions[]`. Never a raw gack or "contact support".
6. **Design invariants are the whole point** and are non-negotiable: deterministic API-name-based file names, human-readable indented JSON, flat-by-type dataspace-aware directory layout, `entityPayload` pass-through byte-for-byte. See [`docs/DESIGN_PRINCIPLES.md`](docs/DESIGN_PRINCIPLES.md).
7. **Thin commands.** A command's `run()` parses flags, resolves the org connection, and delegates to a service — nothing more (~20 lines). All orchestration, telemetry, and error mapping live in `src/shared/services/`.
8. **Confirm before assuming** on the open questions in [`PROJECT_KNOWLEDGE.md`](PROJECT_KNOWLEDGE.md) Appendix (branch target, "BT" permission name, final CLI namespace, plugin name). Don't commit or push unless asked; if on a default branch, branch first.

---

## 📍 Task router — read this first for your task

| If you are…                                                 | Read first                                                          | Then look at (source)                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adding a new CLI command**                                | [`docs/ADDING_A_COMMAND.md`](docs/ADDING_A_COMMAND.md)              | [`retrieve.ts`](src/commands/data-cloud/retrieve.ts) (reference command) + its service [`retrieve-service.ts`](src/shared/services/retrieve-service.ts)                         |
| **Understanding the system / data flows**                   | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                      | the 4 layers: `src/commands/data-cloud/` → `src/shared/services/*-service.ts` → [`devops-api.ts`](src/shared/services/devops-api.ts) → `file-reader.ts`/`file-writer.ts`        |
| **Deciding _how_ to write something** (patterns/invariants) | [`docs/DESIGN_PRINCIPLES.md`](docs/DESIGN_PRINCIPLES.md)            | the enforcing code cited inline in that doc                                                                                                                                     |
| **Working on an API call / endpoint / contract**            | [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md)                      | [`devops-api.ts`](src/shared/services/devops-api.ts) + [`src/shared/types/`](src/shared/types/)                                                                                 |
| **Touching the on-disk file layout / paths / folder names** | [`docs/ON_DISK_FORMAT.md`](docs/ON_DISK_FORMAT.md)                  | [`component-paths.ts`](src/shared/constants/component-paths.ts), [`file-writer.ts`](src/shared/services/file-writer.ts), [`file-reader.ts`](src/shared/services/file-reader.ts) |
| **Adding/changing telemetry**                               | [`docs/TELEMETRY.md`](docs/TELEMETRY.md)                            | [`telemetry.ts`](src/shared/services/telemetry.ts) + [`telemetry-test-utils.ts`](test/shared/telemetry-test-utils.ts)                                                           |
| **Working on diagnostics / local logging**                  | [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md)                        | [`src/shared/diagnostics/`](src/shared/diagnostics/) + [`diagnostics-service.ts`](src/shared/services/diagnostics-service.ts)                                                   |
| **Handling / mapping errors**                               | [`docs/ERROR_HANDLING.md`](docs/ERROR_HANDLING.md)                  | `toSfError()` in [`devops-api.ts`](src/shared/services/devops-api.ts) + error classes in [`file-reader.ts`](src/shared/services/file-reader.ts)                                 |
| **Writing or fixing tests**                                 | [`docs/TESTING.md`](docs/TESTING.md)                                | [`test/setup.ts`](test/setup.ts), a mirror test e.g. [`retrieve.test.ts`](test/commands/data-cloud/retrieve.test.ts), [`src/shared/mocks/`](src/shared/mocks/)                  |
| **Opening a PR / commit style / setup**                     | [`CONTRIBUTING.md`](CONTRIBUTING.md)                                | `.eslintrc.cjs`, `package.json` scripts                                                                                                                                         |
| **Checking scope / business context / weekly plan**         | [`PROJECT_KNOWLEDGE.md`](PROJECT_KNOWLEDGE.md)                      | §2 scope, §5 contracts, §6 plan                                                                                                                                                 |
| **Hitting a known gotcha**                                  | [`PROJECT_KNOWLEDGE.md`](PROJECT_KNOWLEDGE.md) §7 (Troubleshooting) | append new recurring issues to that table                                                                                                                                       |

> `docs/` is **gitignored** (the scaffold reserves it for generated command reference), so those files
> are on disk but untracked. Read them freely; if they must ship in a PR, `git add -f docs/` or narrow
> the ignore rule first.

---

## The commands (build target)

Six commands exist today. The endpoint paths below are the **real** paths in
[`devops-api.ts`](src/shared/services/devops-api.ts) — they have drifted from the original
`/retrieve` `/deploy` names in `PROJECT_KNOWLEDGE.md §5`; **the code wins**. See
[`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) for the authoritative mapping.

| CLI command                         | Service                                                                    | Connect API endpoint                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `sf data-cloud component-type list` | — (`getComponentTypes`)                                                    | `GET /ssot/devops/component-types`                                                         |
| `sf data-cloud component list`      | — (`getComponents`)                                                        | `GET /ssot/devops/component/catalog?componentType=<>[&dataSpaceName=<>]`                   |
| `sf data-cloud retrieve`            | [`retrieve-service.ts`](src/shared/services/retrieve-service.ts)           | `GET /ssot/devops/component/snapshot?componentType=<>&componentName=<>[&dataSpaceName=<>]` |
| `sf data-cloud deploy`              | [`deploy-service.ts`](src/shared/services/deploy-service.ts)               | `POST /ssot/devops/component/promotion`                                                    |
| `sf data-cloud deploy status`       | [`deploy-status-service.ts`](src/shared/services/deploy-status-service.ts) | `GET /ssot/devops/component/promotion/{jobId}`                                             |
| `sf data-cloud diagnostics`         | [`diagnostics-service.ts`](src/shared/services/diagnostics-service.ts)     | none — local-only bundle                                                                   |

- CLI namespace is `data-cloud` for now (may become `d360`/`D3` later — confirm before renaming).
- `src/commands/hello/world.ts` is leftover scaffold; ignore it (safe to delete when asked).

---

## On-disk file layout (full detail: [`docs/ON_DISK_FORMAT.md`](docs/ON_DISK_FORMAT.md))

- 1 component = 1 file: `data-cloud/<dataspace>/<component-type-kebab-plural>/<componentName>.json`.
- DLO **definitions** live at `data-cloud/data-lake-objects/` (dataspace-agnostic; routing decided by `isRootRouted()` / `DATASPACE_AGNOSTIC_TYPES` in [`component-paths.ts`](src/shared/constants/component-paths.ts)).
- Folder names are **derived at runtime** (kebab-case, pluralized) from `componentType` — never a hardcoded catalog. `CalculatedInsight → calculated-insights/`, `DataModelObject → data-model-objects/`.
- Each file is self-describing: `componentType`, `componentName`, `dataspaceName`, `dependsOn[]`, **`entityPayload{}`** (camelCase on disk; stored/transmitted verbatim).
- Root `data-cloud/manifest.json` holds the flattened `deploymentOrder`.

---

## Environment & tooling (binding)

- **Node: v24.** v26 crashes the plugin generator. (`package.json` `engines` says `>=18`; the team standard is v24 — match toolchain versions to other Salesforce plugins.)
- **Yarn only** — never run `npm install` (it produces a lockfile that fights `yarn.lock` and the wireit/`sf-*` scripts).
- **TypeScript** for all commands; **oclif** framework; **@salesforce/sf-plugins-core** (`SfCommand`, `Flags`).
- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `test:`, `refactor:`).
- **Observability (as built):** telemetry → **Azure App Insights** via the `Lifecycle` channel; diagnostics → **local NDJSON** logs. (Splunk/Argus were the original server-side design aspiration; the CLI itself does not forward to Splunk — see [`docs/TELEMETRY.md`](docs/TELEMETRY.md).)
- **Coverage target: ≥80%** via `nyc`.

## Common commands

```bash
yarn install                      # install deps (NEVER npm install)
yarn build                        # compile TypeScript + lint
yarn lint                         # ESLint over src and test
yarn test                         # full gate: unit + lint + schema + command-reference + snapshot
yarn test:only                    # just the unit tests (fast inner loop)
yarn test:nuts                    # integration tests (real CLI via cli-plugins-testkit)
./bin/dev.js data-cloud <cmd>     # run a command locally against a real/scratch org
```

Before a PR: `yarn test` green, coverage ≥80%, `command-snapshot.json` + JSON `schemas/` updated if the
CLI surface changed, messages complete, conventional commit. Full checklist in [`CONTRIBUTING.md`](CONTRIBUTING.md).

---

## Directory map (where things live)

```
src/
  commands/data-cloud/        # Layer 1 — thin oclif commands (parse flags → delegate)
  shared/
    services/                 # Layer 2/3 — orchestrators + the devops-api HTTP client
    diagnostics/              # local NDJSON logging pipeline (config→logger→storage→redact→tar)
    constants/                # component-paths.ts (runtime folder derivation)
    types/                    # request/response + file-layout interfaces
    mocks/                    # typed, realistic fixtures for tests
messages/                     # oclif command text (summary/description/examples/flags/errors)
schemas/                      # generated per-command JSON schemas (guarded by test:json-schema)
test/                         # mirrors src/ (commands/, shared/services/, shared/diagnostics/)
docs/                         # verified architecture docs (gitignored) — the task router above
```

**Dependency direction:** commands import services; services import diagnostics/types/constants.
Services never import commands; commands never import each other.
