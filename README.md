# @salesforce/plugin-datacloud-devops

[![NPM](https://img.shields.io/npm/v/@salesforce/plugin-datacloud-devops.svg?label=@salesforce/plugin-datacloud-devops)](https://www.npmjs.com/package/@salesforce/plugin-datacloud-devops)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://opensource.org/license/apache-2-0)
[![Node](https://img.shields.io/badge/node-v24-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![oclif](https://img.shields.io/badge/built%20with-oclif-purple.svg)](https://oclif.io)

Source-controlled DevOps — `retrieve` and `deploy` — for **Data Cloud (Data 360)** components, delivered as a Salesforce CLI plugin. It brings the familiar `sf project retrieve/deploy` developer loop to Data Cloud: one file per component, deterministic API-name-based file names, and clean human-readable JSON that diffs and merges cleanly in Git. The plugin is a **thin client** over a small set of Connect API endpoints under `/ssot/devops/*` — all heavy lifting (dependency resolution, orchestration) lives server-side.

> **Status: early development (Week 1 scaffolding).** All five commands run locally and return structured **dummy/mock data** — they do not yet contact an org or write files to disk. The data sources behind each command are isolated in [`src/shared/`](src/shared/) so wiring the real Connect API later touches only that layer, not the commands.

---

## Why this exists

Today, every Data Cloud metadata change flows through a manual, multi-step UI bundling process that produces opaque files with random names and encoded payloads. That breaks Git (no meaningful diffs, silent multi-developer overwrites) and can't be driven by AI agents. This plugin replaces that experience with component-level retrieve/deploy that feels identical to core Salesforce DX:

- **1 component = 1 file**, named after its API name (deterministic, mergeable).
- **Human-readable indented JSON** — no encoded XML, no internal packaging artifacts.
- **Stateless, JSON-in / JSON-out** endpoints any consumer (human, CI/CD, or agent) calls identically.
- **Structured, actionable errors** (code + message + failing component).

---

## Tech Stack

| Area                 | Choice                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Language             | **TypeScript** (ES modules)                                                                         |
| CLI framework        | **oclif** (via `@salesforce/sf-plugins-core`)                                                       |
| Runtime              | **Node.js v24** (v26 is incompatible with the plugin generator)                                     |
| Package manager      | **Yarn** (do **not** use `npm install`)                                                             |
| Core libraries       | `@salesforce/core`, `@salesforce/kit`, `@oclif/core`                                                |
| Build orchestration  | **wireit** + `tsc`                                                                                  |
| Testing              | **Mocha** + **Chai** + `nyc` (coverage); `@salesforce/cli-plugins-testkit` for NUTs                 |
| Linting / formatting | ESLint (`eslint-plugin-sf-plugin`) + Prettier                                                       |
| Tooling              | `@salesforce/dev-scripts`, `@oclif/plugin-command-snapshot`, `@salesforce/plugin-command-reference` |
| License              | Apache-2.0                                                                                          |

---

## Project Structure

```
plugin-datacloud-devops/
├── src/
│   ├── commands/data-cloud/            # The five CLI commands (thin oclif command classes)
│   │   ├── component-type/list.ts      #   sf data-cloud component-type list
│   │   ├── component/list.ts           #   sf data-cloud component list
│   │   ├── retrieve.ts                 #   sf data-cloud retrieve
│   │   ├── deploy.ts                   #   sf data-cloud deploy
│   │   └── deploy/status.ts            #   sf data-cloud deploy status
│   ├── shared/                         # Swappable data layer — commands depend only on this
│   │   ├── types/                      #   TypeScript contracts mirroring the Connect API shapes
│   │   └── mocks/                      #   Week-1 dummy data (replaced by a real API client later)
│   └── index.ts                        # Plugin entry point
│
├── messages/                           # Externalized command help, summaries & output strings (.md)
├── schemas/                            # Generated JSON schemas for each command's --json result
├── test/commands/data-cloud/           # Mocha/Chai unit tests, mirroring the command tree
│
├── bin/                                # Local dev runners: ./bin/dev.js (TS) and ./bin/run.js
├── .github/                            # PR template, issue templates, CI workflows
├── package.json                        # Scripts, deps, oclif topic config, wireit build graph
├── PROJECT_KNOWLEDGE.md                # 📖 Single source of truth: architecture, scope, contracts
└── CLAUDE.md                           # Guidance for AI coding agents working in this repo
```

**Architectural rule of thumb:** command files stay _thin_. They parse flags, call into [`src/shared/`](src/shared/), and format output. Each command currently reads from a mock in [`src/shared/mocks/`](src/shared/mocks/); swapping in the real Connect API client is a change to `shared/`, not to the commands. Types in [`src/shared/types/`](src/shared/types/) are the standardized shapes both the mock and the future API client satisfy.

> 📖 **[PROJECT_KNOWLEDGE.md](PROJECT_KNOWLEDGE.md) is the single source of truth** for architecture, exact scope boundaries, API contracts, the on-disk file layout, and the weekly plan. Read it before planning or writing code.

---

## Getting Started

### Prerequisites

- **Node.js v24** — match your toolchain to other Salesforce plugins. (Node v26 crashes the plugin generator.)
- **Yarn** — the only supported package manager for this repo.
- **Salesforce CLI** (`sf`) — to link and run the plugin alongside other commands.

### Installation (local development)

```bash
# Clone the repository
git clone git@github.com:salesforcecli/plugin-datacloud-devops.git
cd plugin-datacloud-devops

# Install dependencies and compile (NEVER run `npm install`)
yarn && yarn build
```

### Running locally

Use the bundled dev runner — no install or link required:

```bash
./bin/dev.js data-cloud component-type list
```

Optionally, link the plugin into your global `sf` CLI so the commands are available anywhere:

```bash
sf plugins link .
sf plugins            # verify it's linked
sf data-cloud component-type list
```

### Common scripts

```bash
yarn install   # Install dependencies (never `npm install`)
yarn build     # Compile TypeScript and run lint checks
yarn lint      # Run ESLint across src and test
yarn test      # Unit tests + command-reference, schema, and deprecation-policy checks
```

---

## Usage

The plugin exposes five commands under the `data-cloud` topic. Each maps directly to a Connect API endpoint:

| Command                             | Endpoint                                      | Purpose                                     |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------- |
| `sf data-cloud component-type list` | `GET /ssot/devops/component-types`            | List supported component types              |
| `sf data-cloud component list`      | `GET /ssot/devops/component-object-api-names` | List components of a type in a dataspace    |
| `sf data-cloud retrieve`            | `POST /ssot/devops/retrieve`                  | Retrieve a component + its dependency graph |
| `sf data-cloud deploy`              | `POST /ssot/devops/deploy`                    | Deploy components in dependency order       |
| `sf data-cloud deploy status`       | `GET /ssot/devops/deploy/{jobId}/status`      | Poll an async deploy job                    |

> Every command supports the global `--json` flag for machine-readable, agent-friendly output.

### List supported component types

```bash
sf data-cloud component-type list
sf data-cloud component-type list --json   # useful for scripts and agents
```

### List components of a type within a dataspace

```bash
sf data-cloud component list \
  --component-type CalculatedInsight \
  --dataspace default \
  --src-org testOrg1
```

### Retrieve a component and its dependency graph

```bash
sf data-cloud retrieve \
  --component CalculatedInsight:highValueCustomer \
  --dataspace default \
  --src-org testOrg1
```

A retrieve returns the requested component **plus** its server-resolved dependencies (e.g. a Calculated Insight and the Data Model Objects it queries). Once the real API is wired, each is persisted as one file per component in a dataspace-aware, flat-by-type layout (see PROJECT_KNOWLEDGE.md §5).

### Deploy to a target org and poll for status

Deploys are **asynchronous** — `deploy` returns immediately with a `jobId` in the `CREATED` state; poll it to completion:

```bash
# Kick off the deploy
sf data-cloud deploy \
  --component CalculatedInsight:HighValueCustomers \
  --dataspace default \
  --target-org uat-org

# Poll the returned job ID (CREATED → INPROGRESS → SUCCESS | FAILED)
sf data-cloud deploy status \
  --job-id 08PVF000002iQIb \
  --target-org uat-org
```

On failure, `deploy status` surfaces the failing component and a structured reason rather than a raw error — for example: _"Expression validation failed: Unknown field …"_.

---

## Contributing

Contributions follow standard Salesforce CLI plugin conventions.

### 1. Branching

- The integration target is the **`develop`** branch (confirm with your lead before opening cross-team PRs).
- Branch off `develop` (or `main`) using a descriptive, type-prefixed name:

  | Prefix     | Use for                                                 |
  | ---------- | ------------------------------------------------------- |
  | `feature/` | New functionality (e.g. `feature/retrieve-file-writer`) |
  | `fix/`     | Bug fixes                                               |
  | `chore/`   | Tooling, deps, scaffolding                              |

### 2. Commit messages — [Conventional Commits](https://www.conventionalcommits.org/)

PR titles and commits are validated against the Conventional Commits spec. Use a type prefix and an imperative summary:

```
feat: add file-system persistence for retrieve responses
fix: handle missing dataspace flag on deploy
chore: bump @salesforce/core to 8.31
test: cover deploy status failure path
docs: document the retrieve dependency-graph contract
```

### 3. Keep code modular and tested

- **Commands stay thin** — put data access and logic in [`src/shared/`](src/shared/), and externalize all user-facing strings to [`messages/`](messages/).
- **Write tests** for every change. This repo targets **≥80% coverage**; add a unit test under `test/` mirroring the command path.
- Run `yarn build && yarn test` before pushing — `yarn test` also runs lint, JSON-schema, and command-reference checks.

### 4. Open a Pull Request

PRs use the repo template ([.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md)), which asks two questions:

```markdown
### What does this PR do?

### What issues does this PR fix or reference?
```

CI runs the build, tests, and PR-title validation automatically. External contributors must sign the [Salesforce CLA](https://cla.salesforce.com/sign-cla). Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## License

[Apache-2.0](LICENSE.txt) © Salesforce, Inc.
