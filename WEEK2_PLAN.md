# Week 2 Plan — Retrieve / Deploy / Deploy Status + Code-Review Fixes

Week of ~Jun 8 2026. This combines the **planned Week 2 build target** with the **code-review
feedback from Himanshu (Jun 5 sync)**, corrected against the actual codebase.

> Cross-checked against the current source on `feature/initial-setup`. Items that differ from the
> raw transcript notes are flagged with **[corrected]**.

---

## Part A — Build target (the three commands)

All three already exist as scaffolding sourcing from `src/shared/mocks/`. Week 2 is about making
them behave correctly against the **mock** Connect API (no real backend yet).

| #   | Command                       | Endpoint (mocked)                        | "Done" looks like                                                                                                           |
| --- | ----------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sf data-cloud retrieve`      | `POST /ssot/devops/retrieve`             | Calls the mock, gets a JSON component list, and **actually writes files to disk** in the correct folder structure (Item 5). |
| 2   | `sf data-cloud deploy`        | `POST /ssot/devops/deploy`               | Takes components, sends to mock, returns a tracking `jobId` in `CREATED` state.                                             |
| 3   | `sf data-cloud deploy status` | `GET /ssot/devops/deploy/{jobId}/status` | Returns status **per component** as a list (Item 3).                                                                        |

Week 1 commands (`component-type list`, `component list`) are already built.

---

## Part B — Code-review fixes (must address)

### 1. Investigate `status` and `warning` in `--json` output

- **What he said:** Confused by `status: 0` / `status: 1` and the `warning` field; worried it confuses customers ("lesser is better").
- **Reality in code:** Nothing in `src/` sets these. They come from oclif / `SfCommand`'s built-in `--json` envelope, **not** your code. `status: 0` is the framework **exit code** (0 = command ran OK), _not_ the HTTP/Connect API status.
- **To do:** Confirm whether other `sf` CLI plugins also emit `status` / `warning` in `--json`. If standard → keep and explain. If not → see if it can be suppressed. Be ready to explain the exit-code-vs-API-status distinction.

### 2. Confirm `--json` is standard practice

- **What he said:** Doesn't recall `--json` in the design doc; asked if it's a common pattern.
- **Reality in code:** `--json` is **not declared** in any command file — it's default `SfCommand` behavior. It is standard across all `sf` commands and makes output machine-parseable for CI/CD.
- **To do:** Keep it. Be ready to justify it. ✅ Low risk.

### 3. Make `deploy status` report at the **component level** as a **list** **[corrected]**

- **What he said:** Status only showed `jobId` + `status`. It should show the **list of components**, each with its own status, and on failure the error details (component name + reason).
- **Reality in code:**
  - `src/shared/types/deploy-status.ts` — `components` is a **single object** (`FailedComponentDetail` = one `componentName` + `error`), not a list.
  - `src/commands/data-cloud/deploy/status.ts:67-71` — it's only populated **on FAILED**; success returns no component breakdown.
  - `src/shared/mocks/deploy-status.mock.ts` — success returns just `{ jobId, status: 'SUCCESS' }`.
- **To do:**
  - Change `components` from a single object → a **list of per-component entries** (each with component name, per-component status, and error reason when failed).
  - Update the mock to return a component list for **both** success and failure cases.
  - Human-readable output: one component per line, with spacing/indentation for readability.
  - JSON output: `components` is a list of objects.

### 4. Split `--component` into `--component-type` + `--component-name` **[corrected]**

- **What he said:** Use `--component-type` and `--component-name` (e.g. `CalculatedInsight` / `HighValueCustomers`).
- **Reality in code (NOT `--source-dir`):**
  - `retrieve.ts` flags: `--component` (single TYPE:NAME flag), `--dataspace`, `--src-org`.
  - `deploy.ts` flags: `--component` (single TYPE:NAME flag), `--dataspace`, `--target-org`.
  - There is **no `--source-dir` flag** anywhere.
- **To do:**
  - Replace the single `--component` flag with two flags `--component-type` and `--component-name` on **both** retrieve and deploy.
  - Update mocks/types/messages that currently parse or echo the `TYPE:NAME` string.
  - **Confirm convention:** kebab-case (`--component-type`) vs camelCase — apply the SF CLI standard consistently.

### 5. Implement the retrieve → file-writing strategy (core Week 2 task) **[corrected — bigger than it looked]**

- **What he said:** Main work for the week. Flow: mock returns a `components` list; each component has `componentType`, `componentName`, `dataSpaceName`; build path `<dataSpaceName>/<componentType>/<componentName>.json` and dump that component's raw JSON as-is. Ordering doesn't matter for retrieve.
- **Reality in code (two gaps):**
  1. **No file writing happens at all.** `retrieve.ts:54-72` only calls `this.log(...)`. Line 68 prints _"Files written to ./data-cloud/..."_ — **misleading; nothing is written.**
  2. **Mock data is too thin.** `retrieve.mock.ts` gives each component only `componentType` + `componentName`. To build the path you also need **`dataspaceName`** per component, and to write the file you need the **actual component payload** (`entityPayload`). Neither exists yet in the mock or in `RetrievedComponentInfo` (`retrieve.ts:26-31`).
- **To do:**
  - Enrich `RetrievedComponentInfo` + the mock with `dataspaceName` and an `entityPayload` (the raw component object).
  - Implement the file writer: for each component, create `<dataspaceName>/<componentType>/<componentName>.json` and dump the component's JSON.
  - Remove/replace the misleading "Files written" log until it's true.
- **Note:** the CLI presentation JSON ≠ the raw Connect API JSON written to disk. The raw component object goes into the file.

### 6. Verify help text & missing-argument behavior

- **Reality in code:** All flags already have `required: true`, so missing-flag errors fire. Help/usage is wired via the `messages/` files.
- **To do:** Run each command with missing args; confirm the usage/required-flag messaging is clear.

---

## Part C — Process / logistics

### 7. Where to push code

- Built in a self-created repo (not cloned from the org) → nowhere to push a PR yet.
- **Interim:** fork the CLI repo and push there for review.
- **Pending:** Arushi is checking how to create a team-owned repo. Follow up.

---

## ⚠️ Layout conflict to resolve before writing the file-writer

PROJECT_KNOWLEDGE.md §5 and the transcript don't fully agree:

- **PROJECT_KNOWLEDGE.md §5:** files are **self-describing** (`componentType`, `componentName`,
  `dataspaceName`, `dependsOn[]`, `entityPayload{}`), folders are **kebab-case plural**
  (`calculated-insights/`, `data-model-objects/`), DLO definitions live at
  `data-cloud/data-lake-objects/`, plus a root `manifest.json` with `deploymentOrder`.
- **Transcript (Himanshu):** simpler — `dataSpaceName/componentType/componentName.json`, dump the
  raw object as-is.

Per hard rule #7, **confirm which layout to build** before coding the writer.

---

## Open questions to confirm (don't guess — ask the team)

1. Are `status` / `warning` standard in other SF CLI plugins' `--json`? → Item 1
2. Is `--json` expected by the design doc / standard? → Item 2 (likely yes, keep)
3. Flag casing: kebab-case vs camelCase? → Item 4
4. File layout: self-describing kebab-plural (§5) vs raw `dataSpace/type/name.json` dump? → Item 5
5. Where is the team-owned repo for PRs? → Item 7
