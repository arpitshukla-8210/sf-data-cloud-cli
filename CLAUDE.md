# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.

## 📖 Read this first

**[PROJECT_KNOWLEDGE.md](PROJECT_KNOWLEDGE.md) is the single source of truth for this project.**
Before planning or writing any code, read it. It contains the architecture, exact scope boundaries,
API contracts, file formats, the weekly plan, and a known-issues log. This file is only a short
pointer + the rules you must never violate. **If anything here conflicts with PROJECT_KNOWLEDGE.md,
PROJECT_KNOWLEDGE.md wins** — and tell me about the conflict.

## What this project is (one paragraph)

`@salesforce/plugin-datacloud-devops` is an internal Salesforce CLI plugin that brings
source-controlled DevOps (retrieve / deploy) to **Data Cloud (Data 360)** components, at parity with
core `sf project retrieve/deploy`. The CLI is a **thin client** over three **Connect API** endpoints
under `/ssot/devops/*`. This is an **internship project** owned by Arpit Shukla; a separate developer
owns the server-side implementation and spidering.

## 🚦 Hard rules — do not violate

1. **Stay in scope.** I own the **CLI** (Layer 1) and the **Connect API contracts** (Layer 2 representation classes). I do **NOT** own the Connect API _implementation_, **spidering**, or the **DataKit Orchestration Layer** (Layer 3). If a task drifts into those, **stop and flag it** — do not implement it.
2. **End-to-end coverage = CalculatedInsight + its DMO dependencies only.** Write code generically (it could extend to all ~30+ types), but only CI+DMO must work end-to-end. (Dummy/mock `retrieve` this sprint also exercises **Data Transform**.)
3. **Never invent** endpoints, field names, component types, or file shapes. Use the exact contracts in PROJECT_KNOWLEDGE.md §5. If something isn't specified, ask — don't guess.
4. **Never surface DataKit internals.** No DataKit names, template names, `&quot;`-encoded XML, or internal dependency objects in CLI output or in files written to disk.
5. **Design invariants are non-negotiable:** deterministic API-name-based file names, human-readable indented JSON, flat-by-type dataspace-aware directory structure. These are the entire point of the project.
6. **Errors must be structured and actionable** (code + message + failing component) — never raw gacks or "contact support."
7. **Confirm before assuming** on the open questions in PROJECT_KNOWLEDGE.md's Appendix (branch target, "BT" permission name, final CLI namespace, plugin name).

## The five commands (the build target)

| CLI Command                         | Endpoint                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `sf data-cloud component-type list` | `GET /ssot/devops/component-types`                                              |
| `sf data-cloud component list`      | `GET /ssot/devops/component-object-api-names?componentType=<>&dataSpaceName=<>` |
| `sf data-cloud retrieve`            | `POST /ssot/devops/retrieve`                                                    |
| `sf data-cloud deploy`              | `POST /ssot/devops/deploy`                                                      |
| `sf data-cloud deploy status`       | `GET /ssot/devops/deploy/{jobId}/status`                                        |

CLI namespace is `data-cloud` for now (may become `d360`/`D3` later — confirm before renaming).

## On-disk file layout (see §5 for full detail)

- 1 component = 1 file: `data-cloud/<dataspace>/<component-type-kebab-plural>/<componentName>.json`
- DLO _definitions_ live at `data-cloud/data-lake-objects/` (dataspace-agnostic, org-level).
- Each file is self-describing: `componentType`, `componentName`, `dataspaceName`, `dependsOn[]`, **`entityPayload{}`** (camelCase on disk).
- Root `data-cloud/manifest.json` holds the flattened `deploymentOrder`.
- Folder names are **kebab-case, plural** (`calculated-insights/`, `data-model-objects/`).

## Environment & tooling (binding — see §4)

- **Node: v24** (v26 crashes the plugin generator). Match toolchain versions to other Salesforce plugins.
- **Package manager: Yarn only** — do **not** run `npm install`.
- **Language: TypeScript** for all command implementations; **framework: oclif**.
- **Commits: Conventional Commits** (e.g. `feat:`, `fix:`, `chore:`, `test:`).
- **IDE split:** VS Code for this CLI work; IntelliJ (+ Bazel) for the Java/backend contract side.
- **Tests:** JUnit, **≥80% coverage** on CLI + contract classes; FIT tests (retrieve→deploy→status) against an orgfarm org, passing in SFCI.
- **Observability:** structured logs → Splunk; metrics → Argus; correlation IDs across CLI → Connect API → DataKit. Mirror how the existing `sf` CLI logs/emits metrics.
- **Java contract conventions:** `@ConnectInputRep`/`@ConnectOutputRep`, the `_isSet` pattern, `minVersion`, permission checks. Reference module: `cdp-connect-api/`.

## Common commands

```bash
yarn install            # Install dependencies (NEVER run npm install)
yarn build              # Compile TypeScript code and run linting checks
yarn lint               # Run ESLint validation across src and test directories
yarn test               # Run all unit tests, reference validations, and schema checks
./bin/dev.js <command>  # Run a command locally during development
```

## Git / workflow

- Working branch: `feature/initial-setup`. Integration target: **`develop`** (confirm with Ayush).
- Don't commit or push unless I ask. If on a default branch, branch first.
- Keep code **modular** with correct directory/file structure — this scaffolding is the backbone of all future changes and must be extensible toward production.

## Current focus (Week 1, week of ~Jun 8 2026 — see §6 for the full plan)

Build all **five dummy commands** runnable locally returning dummy/structured data; dummy `retrieve`
covers **CI + Data Transform** (mock CI response includes a `dependsOn` array). Then ping the team on
Slack for validation. Stretch: prove the CLI can connect to an orgfarm org and hit any Connect API.

## When you hit a problem

Check **§7 (Troubleshooting & Known Issues)** in PROJECT_KNOWLEDGE.md first — common gotchas (Node
v26, DataKit type, sandbox point-in-time, permission/incognito, concurrency) are already logged
there. Append new recurring issues to that table.
