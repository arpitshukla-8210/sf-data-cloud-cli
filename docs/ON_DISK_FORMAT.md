# On-Disk Format — the `data-cloud/` file layout contract

> **Audience:** anyone who needs to understand _exactly_ where `sf data-cloud retrieve` writes files, where `sf data-cloud deploy` reads them back, and why the layout is shaped the way it is. No prior context assumed.
>
> **Scope:** this document owns the **on-disk contract** — the tree shape, the routing rules, the folder/file naming, and the JSON schema of every file the CLI writes. It is the single reference for the file format produced and consumed by the CLI (Layer 1). The wire/API contracts live in [docs/API_CONTRACT.md](API_CONTRACT.md); the reasoning behind the invariants lives in [docs/DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md).
>
> **Code is the source of truth.** Every path, field name, and rule below is quoted from the code and cited to a line. Where a repo doc (CLAUDE.md / PROJECT_KNOWLEDGE.md) disagrees, the code wins and the discrepancy is flagged.

---

## Table of contents

1. [The tree at a glance](#1-the-tree-at-a-glance)
2. [Routing: root vs. dataspace folder (`isRootRouted`)](#2-routing-root-vs-dataspace-folder-isrootrouted)
3. [Folder naming (`toKebabCase` + `pluralize`)](#3-folder-naming-tokebabcase--pluralize)
4. [File naming: `<componentName>.json`](#4-file-naming-componentnamejson)
5. [The component file JSON schema (5 required fields)](#5-the-component-file-json-schema-5-required-fields)
6. [`manifest.json` schema](#6-manifestjson-schema)
7. [The writer → reader round-trip guarantee](#7-the-writer--reader-round-trip-guarantee)
8. [Extending `DATASPACE_AGNOSTIC_TYPES`](#8-extending-dataspace_agnostic_types)

---

## 1. The tree at a glance

A single `sf data-cloud retrieve` run materializes one directory tree rooted at `data-cloud/`, relative to the current working directory (the _base dir_). Two invariants shape it:

- **1 component = 1 file.** Every retrieved component (the one you asked for, plus every transitive dependency the server spidered) becomes exactly one self-describing JSON file.
- **Flat, by type, dataspace-aware.** Files are grouped by component _type_ (kebab-case, plural folder names), nested under their _dataspace_ — except for dataspace-agnostic types, which live at the root.

Here is a realistic tree for retrieving `CalculatedInsight:highValueCustomer` in dataspace `default`, using the exact fixture the codebase ships in [retrieve-api-response.mock.ts](../src/shared/mocks/retrieve-api-response.mock.ts). That fixture contains five components (a Calculated Insight, a Data Transform, two Data Model Objects, and a Data Lake Object) wired together by `dependsOn` edges:

```text
data-cloud/                                  ← ROOT_DIR (constant 'data-cloud')
├── manifest.json                            ← MANIFEST_FILE — flattened deploymentOrder for the run
│
├── data-lake-objects/                       ← DLOs are DATASPACE-AGNOSTIC → live at the ROOT (no dataspace folder)
│   └── myDLO.json
│
└── default/                                 ← the dataspace folder (dataspaceName = 'default')
    ├── calculated-insights/                 ← CalculatedInsight  → kebab-case, PLURAL
    │   └── highValueCustomer.json
    ├── data-model-objects/                  ← DataModelObject
    │   ├── Divvy_TripsDmo.json
    │   └── AccountDmo.json
    └── data-transforms/                     ← DataTransform
        └── myTransform.json
```

Key things to read off this tree:

| Observation                                          | Where it comes from                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root folder is literally `data-cloud/`               | `ROOT_DIR = 'data-cloud'` — [component-paths.ts:107](../src/shared/constants/component-paths.ts#L107)                                                                                             |
| The manifest sits at the root as `manifest.json`     | `MANIFEST_FILE = 'manifest.json'` — [component-paths.ts:110](../src/shared/constants/component-paths.ts#L110); path assembled at [file-writer.ts:102](../src/shared/services/file-writer.ts#L102) |
| `data-lake-objects/` is **not** under `default/`     | `DataLakeObject` is dataspace-agnostic — routed to root by `isRootRouted` (see §2)                                                                                                                |
| Folder names are kebab-case and **plural**           | `folderForComponentType` = `toKebabCase` + `pluralize` (see §3)                                                                                                                                   |
| File names are the raw component API name + `.json`  | `${componentName}.json` — [file-writer.ts:52](../src/shared/services/file-writer.ts#L52) (see §4)                                                                                                 |
| Multiple DMOs share one `data-model-objects/` folder | flat-by-type: one folder per type, many files inside                                                                                                                                              |

> **A note on the DLO's `dataspaceName`.** In the shipped fixture, every component — _including_ `myDLO` — carries `dataspaceName: dataspace` ([retrieve-api-response.mock.ts:93](../src/shared/mocks/retrieve-api-response.mock.ts#L93)). The fixture just stamps the dataspace on everything; the **writer** decides routing. Because `DataLakeObject` is in `DATASPACE_AGNOSTIC_TYPES`, `isRootRouted` returns `true` and the DLO lands at `data-cloud/data-lake-objects/`, not under `default/`. The fixture data and the on-disk placement can legitimately differ — routing is the writer's job, not the payload's.

> **Terminology.** "Base dir" is the directory the tree is rooted under. In production it is `process.cwd()`; in tests it is a throwaway temp dir passed as `options.baseDir`. Everything below is relative to that base dir.

---

## 2. Routing: root vs. dataspace folder (`isRootRouted`)

Every component is placed by one decision: does it live at the `data-cloud/` **root** (dataspace-agnostic, org-level), or inside a **`data-cloud/<dataspace>/`** subfolder? That decision is made by a single function, so the writer and reader can never disagree.

### The function

From [component-paths.ts:102–104](../src/shared/constants/component-paths.ts#L102):

```ts
export function isRootRouted(componentType: string, dataspaceName?: string | null): boolean {
  return DATASPACE_AGNOSTIC_TYPES.has(componentType) || dataspaceName == null || dataspaceName.trim() === '';
}
```

It returns `true` (→ store at root, no dataspace folder) when **any** of these hold:

1. **The type is dataspace-agnostic** — `DATASPACE_AGNOSTIC_TYPES.has(componentType)`.
2. **No dataspace was given** — `dataspaceName == null` (the `== null` catches both `null` and `undefined`).
3. **The dataspace is blank** — `dataspaceName.trim() === ''` (empty or whitespace-only).

Otherwise it returns `false` and the component is stored under its dataspace folder.

### The set of dataspace-agnostic types

From [component-paths.ts:89–93](../src/shared/constants/component-paths.ts#L89):

```ts
/**
 * Types whose definitions are dataspace-agnostic (org-level) and live at the `data-cloud/` root,
 * OUTSIDE any dataspace folder (§5.2). A Set so this stays extensible.
 */
export const DATASPACE_AGNOSTIC_TYPES = new Set<string>(['DataLakeObject']);
```

Today the set contains exactly one entry: `'DataLakeObject'`. DLO _definitions_ are org-level (they exist independent of any single dataspace), so they belong at the root. See §8 for how to extend this.

### Why one function, and why this design

The routing rule is deliberately centralized here (not duplicated in the writer and reader). The module doc calls this out ([component-paths.ts:95–101](../src/shared/constants/component-paths.ts#L95)):

> True for dataspace-agnostic types (e.g. DataLakeObject) AND for any component whose dataspaceName is empty/null/undefined — generalizing the original DLO-only special case. **Single source of truth for both the file-writer (retrieve → disk) and the file-reader (disk → deploy); keeping the rule here makes it trivial to reverse.**

Conditions 2 and 3 (missing/blank dataspace → root) generalize the original DLO-only special case: a `retrieve` run with no `--dataspace` writes _everything_ to the root, and the tree still round-trips. This is why the writer normalizes a missing dataspace to `''` on disk (see §5 and §7) — that empty string then makes `isRootRouted` return `true` on the read side too.

### The two resulting shapes

Both the writer and the reader build the path the same way. From the writer's private `pathForComponent` ([file-writer.ts:50–57](../src/shared/services/file-writer.ts#L50)):

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

| `isRootRouted` result                        | On-disk path                                           |
| -------------------------------------------- | ------------------------------------------------------ |
| `true` (agnostic type OR no/blank dataspace) | `data-cloud/<folder>/<componentName>.json`             |
| `false` (dataspace-scoped)                   | `data-cloud/<dataspace>/<folder>/<componentName>.json` |

Worked from the tree in §1:

- `DataLakeObject:myDLO` → `isRootRouted('DataLakeObject', 'default')` is `true` (agnostic type) → `data-cloud/data-lake-objects/myDLO.json`.
- `CalculatedInsight:highValueCustomer` → `isRootRouted('CalculatedInsight', 'default')` is `false` → `data-cloud/default/calculated-insights/highValueCustomer.json`.

The reader's exported `pathForComponent` is the mirror image — same routing, flat args instead of a component object ([file-reader.ts:51–63](../src/shared/services/file-reader.ts#L51)).

---

## 3. Folder naming (`toKebabCase` + `pluralize`)

Folder names are **derived at runtime** from the backend `componentType`, never looked up in a hardcoded catalog. The whole point ([component-paths.ts:24–28](../src/shared/constants/component-paths.ts#L24)):

> Folder names are DERIVED from the backend `componentType` at runtime (kebab-case + pluralize) rather than looked up in a hardcoded catalog, so a new backend component type gets a correct folder with ZERO CLI changes. Every type — with no exceptions or overrides — flows through the same derivation, so the whole tree follows one consistent kebab-case, PLURAL standard.

> **Design note.** This runtime derivation replaced an older hardcoded catalog (commit `47ae970 refactor(paths): derive component folders at runtime instead of a hardcoded catalog`). There are **no per-type overrides** — every type, current or future, flows through the same two-step pipeline: kebab-case the type, then pluralize it. See [docs/DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) for why extensibility toward ~30+ types drove this.

The public entry point composes the two steps ([component-paths.ts:78–87](../src/shared/constants/component-paths.ts#L78)):

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

It throws a structured `SfError('InvalidComponentTypeError')` **only** when the type is empty/blank or slugifies to nothing (all punctuation) — never merely because a type is unfamiliar. An unknown-but-valid type succeeds; that is the "no catalog" guarantee in action.

### Step 1 — `toKebabCase`

From [component-paths.ts:38–48](../src/shared/constants/component-paths.ts#L38):

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

The steps, in order (the order matters — the acronym rule at line 42 must run _after_ the lower→Upper rule at line 41):

1. **NFKD normalize** — decompose Unicode so accents/compatibility chars reduce to plain ASCII where possible.
2. **PascalCase boundary** (`([a-z0-9])([A-Z])`) — insert a space between a lower/digit and a following uppercase: `CalculatedInsight` → `Calculated Insight`.
3. **Acronym-run boundary** (`([A-Z]+)([A-Z][a-z])`) — split a run of caps before a Word start: `HTTPConnection` → `HTTP Connection`.
4. **Letter→digit** and **digit→letter** boundaries — `Data2Object` → `Data 2 Object`.
5. **Lowercase.**
6. **Collapse every non-alphanumeric run to a single hyphen** — spaces, `_`, unicode, and path chars `/`, `\`, `:`, `..`, null bytes all collapse to `-`.
7. **Trim leading/trailing hyphens.**

**Security is baked in here.** Because separators and `..` carry no alphanumerics, they collapse or trim away — so a derived folder name **can never escape the `data-cloud/` tree** ([component-paths.ts:34–36](../src/shared/constants/component-paths.ts#L34)). This is not incidental; it is a path-traversal guarantee, verified by tests.

Worked examples — verbatim from [component-paths.test.ts](../test/shared/constants/component-paths.test.ts):

| Input               | `toKebabCase` output | Rule exercised                  | Test line                                                   |
| ------------------- | -------------------- | ------------------------------- | ----------------------------------------------------------- |
| `CalculatedInsight` | `calculated-insight` | PascalCase split                | [:22](../test/shared/constants/component-paths.test.ts#L22) |
| `DataModelObject`   | `data-model-object`  | PascalCase split                | [:23](../test/shared/constants/component-paths.test.ts#L23) |
| `HTTPConnection`    | `http-connection`    | **acronym run** split           | [:27](../test/shared/constants/component-paths.test.ts#L27) |
| `DataAPIObject`     | `data-api-object`    | **acronym run** split           | [:28](../test/shared/constants/component-paths.test.ts#L28) |
| `Data2Object`       | `data-2-object`      | digit boundaries                | [:32](../test/shared/constants/component-paths.test.ts#L32) |
| `Data Model Object` | `data-model-object`  | separator collapse (idempotent) | [:36](../test/shared/constants/component-paths.test.ts#L36) |
| `Data_Model_Object` | `data-model-object`  | separator collapse              | [:37](../test/shared/constants/component-paths.test.ts#L37) |
| `data-model-object` | `data-model-object`  | already kebab (idempotent)      | [:38](../test/shared/constants/component-paths.test.ts#L38) |
| `../../etc/passwd`  | `etc-passwd`         | **path traversal neutralized**  | [:44](../test/shared/constants/component-paths.test.ts#L44) |
| `..`                | `` (empty)           | traversal → nothing             | [:45](../test/shared/constants/component-paths.test.ts#L45) |
| `/`                 | `` (empty)           | separator → nothing             | [:46](../test/shared/constants/component-paths.test.ts#L46) |
| `a/b\c:d`           | `a-b-c-d`            | mixed separators collapse       | [:47](../test/shared/constants/component-paths.test.ts#L47) |
| `Type\u0000Name`    | `type-name`          | null byte collapse              | [:48](../test/shared/constants/component-paths.test.ts#L48) |

Note the acronym case in particular: `DataAPIObject` becomes `data-api-object`, **not** `data-a-p-i-object`, because rule 3 splits the cap run `API` at the boundary before `Object`, keeping `api` as one token.

### Step 2 — `pluralize`

From [component-paths.ts:55–69](../src/shared/constants/component-paths.ts#L55):

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

Rules (a minimal English rule set — deliberately no irregular-plural library):

- Only the **last** hyphen segment is pluralized; earlier segments are untouched.
- **Already plural** (ends in `s`) or **empty** last segment → returned unchanged (idempotent).
- Ends in `sh | ch | x | z` → append `es`.
- Consonant + `y` → replace `y` with `ies`.
- Otherwise → append `s`.

Worked examples — verbatim from [component-paths.test.ts](../test/shared/constants/component-paths.test.ts):

| Input                | `pluralize` output    | Rule                        | Test line                                                   |
| -------------------- | --------------------- | --------------------------- | ----------------------------------------------------------- |
| `calculated-insight` | `calculated-insights` | `+s`                        | [:60](../test/shared/constants/component-paths.test.ts#L60) |
| `data-graph`         | `data-graphs`         | `+s`                        | [:61](../test/shared/constants/component-paths.test.ts#L61) |
| `data-streams`       | `data-streams`        | already plural (idempotent) | [:65](../test/shared/constants/component-paths.test.ts#L65) |
| `data-mesh`          | `data-meshes`         | `sh` → `+es`                | [:70](../test/shared/constants/component-paths.test.ts#L70) |
| `data-box`           | `data-boxes`          | `x` → `+es`                 | [:71](../test/shared/constants/component-paths.test.ts#L71) |
| `data-proxy`         | `data-proxies`        | consonant + `y` → `ies`     | [:72](../test/shared/constants/component-paths.test.ts#L72) |
| `data-model-object`  | `data-model-objects`  | last segment only           | [:76](../test/shared/constants/component-paths.test.ts#L76) |

### End-to-end: `folderForComponentType`

Chaining both steps, verbatim from the folder-derivation tests ([component-paths.test.ts:82–96](../test/shared/constants/component-paths.test.ts#L82)):

| `componentType` (input) | Folder (output)        | Notes                                                                                                                  |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `CalculatedInsight`     | `calculated-insights`  | the canonical example                                                                                                  |
| `DataModelObject`       | `data-model-objects`   |                                                                                                                        |
| `DataTransform`         | `data-transforms`      |                                                                                                                        |
| `DataLakeObject`        | `data-lake-objects`    | the root-routed DLO folder — **derived, not hardcoded**                                                                |
| `IdentityResolution`    | `identity-resolutions` |                                                                                                                        |
| `DataConnection`        | `data-connections`     |                                                                                                                        |
| `DataAction`            | `data-actions`         |                                                                                                                        |
| `DataGraph`             | `data-graphs`          |                                                                                                                        |
| `MarketSegment`         | `market-segments`      | formerly an irregular override, now derived                                                                            |
| `DataStreamBundle`      | `data-stream-bundles`  |                                                                                                                        |
| `DataMesh`              | `data-meshes`          | **a brand-new type gets a folder with zero CLI changes** ([:96](../test/shared/constants/component-paths.test.ts#L96)) |

> **Discrepancy flagged.** CLAUDE.md / PROJECT_KNOWLEDGE describe DLO definitions as living at `data-cloud/data-lake-objects/`. The code agrees on the _result_ but there is **no hardcoded `data-lake-objects` literal anywhere** — the folder is derived by `folderForComponentType('DataLakeObject')` → `data-lake-objects`. Same output, different (and better) mechanism.

---

## 4. File naming: `<componentName>.json`

The file name is the component's API/developer name, verbatim, with a `.json` extension. Only the _folder_ is slugged; the _file stem_ is not.

Both sides derive it identically:

- Writer: `const fileName = \`${component.componentName}.json\`;` — [file-writer.ts:52](../src/shared/services/file-writer.ts#L52)
- Reader: `const fileName = \`${componentName}.json\`;` — [file-reader.ts:58](../src/shared/services/file-reader.ts#L58)

And the type contract records that `componentName` doubles as the file stem ([file-layout.ts:31–32](../src/shared/types/file-layout.ts#L31)):

```ts
/** API/developer name of the component; also the file name stem (deterministic, §5.1). */
componentName: string;
```

So `CalculatedInsight:highValueCustomer` in dataspace `default` → `data-cloud/default/calculated-insights/highValueCustomer.json`, and `DataModelObject:Divvy_TripsDmo` → `data-cloud/default/data-model-objects/Divvy_TripsDmo.json`. Note that names like `Divvy_TripsDmo` keep their underscores and casing exactly — the file stem is **not** kebab-cased.

### Why deterministic, API-name-based names

This is a **non-negotiable design invariant**, not a convenience. The rationale:

- **Clean Git diffs.** The same component always lands at the same path with the same file name, so re-running `retrieve` overwrites in place (writes are idempotent — [file-writer.ts:37](../src/shared/services/file-writer.ts#L37), [:75](../src/shared/services/file-writer.ts#L75)). A change to a component shows up as a diff on _one stable file_, not as a delete-plus-add of a randomly named file.
- **Multi-developer conflict resolution.** Because the path is a pure function of `(dataspace, componentType, componentName)`, two developers who both retrieve the same component produce byte-identical file _locations_. Merge conflicts surface on the actual component content, at a predictable path, instead of on churny filenames or ordering.
- **Human navigability.** A reviewer can find `highValueCustomer` by walking `data-cloud/<dataspace>/calculated-insights/` — no index lookup, no opaque IDs.

See [docs/DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md) for the full treatment of the deterministic-naming invariant.

---

## 5. The component file JSON schema (5 required fields)

Every component file on disk is a small, self-describing JSON object with **exactly five top-level fields**. The type contract is [file-layout.ts:27–43](../src/shared/types/file-layout.ts#L27):

```ts
export type ComponentFile = {
  /** API value of the component type, e.g. "CalculatedInsight". */
  componentType: string;
  /** API/developer name of the component; also the file name stem (deterministic, §5.1). */
  componentName: string;
  /** Developer name of the dataspace this component belongs to. */
  dataspaceName: string;
  /** Direct dependencies (server-resolved); empty array for leaf components. */
  dependsOn: ComponentDependency[];
  /**
   * Type-specific payload under this camelCase key on disk (§5.1) — always a JSON object
   * (`Map<String,Object>` on the wire). Stored verbatim and never re-parsed, so it round-trips
   * byte-for-byte on deploy.
   */
  entityPayload: unknown;
};
```

The writer emits these five, in this exact order, from [file-writer.ts:86–95](../src/shared/services/file-writer.ts#L86):

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

### Field reference

| Field           | Type                    | Meaning                                                   | Notes                                                                                                                                                                  |
| --------------- | ----------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `componentType` | `string`                | API value of the type, e.g. `"CalculatedInsight"`         | Drives the folder name (§3)                                                                                                                                            |
| `componentName` | `string`                | API/developer name, e.g. `"highValueCustomer"`            | Also the file stem (§4)                                                                                                                                                |
| `dataspaceName` | `string`                | Dataspace developer name                                  | **Normalized to `''`** when null/absent — [file-writer.ts:91](../src/shared/services/file-writer.ts#L91). See "why" below.                                             |
| `dependsOn`     | `ComponentDependency[]` | Direct, server-resolved dependency edges; `[]` for leaves | Each edge is `{ componentName, componentType }` — [retrieve.ts (`ComponentDependency`)](../src/shared/types/retrieve.ts#L28)                                           |
| `entityPayload` | `unknown`               | The type-specific component definition, verbatim          | Stored byte-for-byte; **never re-parsed** (§7). No DataKit XML, no `&quot;` encoding — native JSON only ([file-layout.ts:22](../src/shared/types/file-layout.ts#L22)). |

Each `dependsOn` edge is a `{ componentName, componentType }` pair (the depended-on component's identity), which is exactly what the reader needs to locate that dependency's file on disk (see §7).

### Why `dataspaceName` is normalized to `''`

The writer coalesces a null/absent `dataspaceName` to the empty string ([file-writer.ts:84–85](../src/shared/services/file-writer.ts#L84)):

> Normalize a null/absent dataspaceName to '' so the on-disk file stays self-describing and the file-reader's required-field check (which rejects `undefined`) still passes (§5.1).

Two things fall out of that empty string:

1. The file still has all five keys, so the reader's required-field validation passes (see §7).
2. On read-back, `isRootRouted(type, '')` returns `true` (blank dataspace), so a component written without a dataspace is found at the root — the round-trip holds even for dataspace-less retrieves.

### A full, annotated example file

`data-cloud/default/calculated-insights/highValueCustomer.json` — built from the shipped CI fixture ([retrieve-api-response.mock.ts:39–59](../src/shared/mocks/retrieve-api-response.mock.ts#L39)), serialized exactly as the writer does (2-space indent, trailing newline — [file-writer.ts:59–62](../src/shared/services/file-writer.ts#L59)):

```json
{
  "componentType": "CalculatedInsight",
  "componentName": "highValueCustomer",
  "dataspaceName": "default",
  "dependsOn": [
    {
      "componentName": "Divvy_TripsDmo",
      "componentType": "DataModelObject"
    }
  ],
  "entityPayload": {
    "masterLabel": "testCI",
    "expression": "SELECT COUNT(Divvy_TripsDmo__dlm.DataSource__c) AS cnt__c, Divvy_TripsDmo__dlm.from_station_name__c AS grp__c FROM Divvy_TripsDmo__dlm GROUP BY grp__c",
    "builderExpression": {
      "app": { "insightType": "CALCULATED_METRIC", "targetCurrencyType": "" },
      "dataNodes": {},
      "ui": {},
      "relatedDMOs": []
    },
    "definitionType": "CALCULATED_METRIC",
    "creationType": "Custom",
    "scheduleInterval": "0",
    "sourceObjectDevName": "testCI"
  }
}
```

Reading it top to bottom:

- `componentType` + `componentName` + `dataspaceName` together determine this file's path — you can reconstruct `data-cloud/default/calculated-insights/highValueCustomer.json` from them alone.
- `dependsOn` names one edge to `DataModelObject:Divvy_TripsDmo`. That is the reader's map: to deploy this CI, the reader will read `Divvy_TripsDmo.json` too (§7).
- `entityPayload` is the CI's own definition, carried through unchanged. The CLI does not interpret it — it stores whatever the API returned. A **leaf** component (e.g. `AccountDmo`) has the same shape but `"dependsOn": []`.

> **`entityPayload` is deliberately `unknown` on disk.** The raw-API type constrains the payload to an object (`RawRetrievedComponent.entityPayload: Record<string, unknown>`), but the on-disk `ComponentFile` widens it to `unknown` ([file-layout.ts:42](../src/shared/types/file-layout.ts#L42)) so that string payloads (e.g. for some Data Transform / DLO shapes) also round-trip. The CLI's rule is: **never re-parse the payload** — a string stays a string, an object stays an object. This is what "round-trips byte-for-byte on deploy" ([file-layout.ts:39–40](../src/shared/types/file-layout.ts#L39)) means. See [docs/API_CONTRACT.md](API_CONTRACT.md) for the wire-side payload discussion.

---

## 6. `manifest.json` schema

At the root of the tree sits `data-cloud/manifest.json`: the flattened, ordered inventory of everything the run retrieved. It exists so a later `deploy` (and a human reviewer) has one authoritative list of _what_ was retrieved and in _what order_, without walking the whole tree.

The type is [file-layout.ts:45–56](../src/shared/types/file-layout.ts#L45):

```ts
/** One entry in `manifest.json` `deploymentOrder` (§5.8 — exactly these three keys). */
export type ManifestEntry = {
  componentType: string;
  componentName: string;
  dataspaceName: string;
};

/** Root `data-cloud/manifest.json`: the flattened deployment order for a retrieve (§5.8). */
export type Manifest = {
  /** Every retrieved component (including dataspace-agnostic DLOs), in server deployment order. */
  deploymentOrder: ManifestEntry[];
};
```

A `ManifestEntry` has **exactly three keys** — `componentType`, `componentName`, `dataspaceName` — and deliberately **no** `dependsOn` and **no** `entityPayload` (those live in the per-component files, §5). The manifest is a lightweight index, not a second copy of the data.

The writer builds `deploymentOrder` by mapping the components in the exact order the server returned them ([file-writer.ts:97–102](../src/shared/services/file-writer.ts#L97)):

```ts
const deploymentOrder: ManifestEntry[] = components.map((component) => ({
  componentType: component.componentType,
  componentName: component.componentName,
  dataspaceName: component.dataspaceName ?? '',
}));
const manifestPath = join(options.baseDir, ROOT_DIR, MANIFEST_FILE);
```

Two things to note:

- The array **preserves server response order** — this _is_ the deployment order (the server topologically orders the graph; the CLI just records it).
- It includes **every** component, including dataspace-agnostic DLOs (which live at the root on disk but still appear in the one flat manifest).

### Example `manifest.json`

For the five-component fixture in §1, in server order (CI → its DMO → the Data Transform → its DLO → the shared DMO):

```json
{
  "deploymentOrder": [
    { "componentType": "CalculatedInsight", "componentName": "highValueCustomer", "dataspaceName": "default" },
    { "componentType": "DataModelObject", "componentName": "Divvy_TripsDmo", "dataspaceName": "default" },
    { "componentType": "DataTransform", "componentName": "myTransform", "dataspaceName": "default" },
    { "componentType": "DataLakeObject", "componentName": "myDLO", "dataspaceName": "default" },
    { "componentType": "DataModelObject", "componentName": "AccountDmo", "dataspaceName": "default" }
  ]
}
```

(As written, this is pretty-printed with 2-space indentation and a trailing newline via the same `serialize` helper — [file-writer.ts:117](../src/shared/services/file-writer.ts#L117). The one-line-per-entry layout above is only for readability here.)

---

## 7. The writer → reader round-trip guarantee

The central promise of this format: **the reader finds exactly what the writer wrote, at the same path, with `entityPayload` intact byte-for-byte.** This is not luck — it is enforced by both sides importing the _same_ path-derivation functions from [component-paths.ts](../src/shared/constants/component-paths.ts).

### Both sides share the same path engine

```text
             component-paths.ts
      ┌──────────────────────────────────┐
      │ folderForComponentType()          │
      │ isRootRouted()                    │
      │ ROOT_DIR = 'data-cloud'           │
      └───────────┬──────────────┬────────┘
                  │              │
     import       │              │      import
                  ▼              ▼
        file-writer.ts     file-reader.ts
     (retrieve → disk)     (disk → deploy)
```

- The **writer** imports them at [file-writer.ts:21](../src/shared/services/file-writer.ts#L21): `folderForComponentType, isRootRouted, ROOT_DIR, MANIFEST_FILE`.
- The **reader** imports them at [file-reader.ts:21](../src/shared/services/file-reader.ts#L21): `folderForComponentType, isRootRouted, ROOT_DIR`.

Because the folder derivation and routing rule are single-sourced, the writer's `pathForComponent` ([file-writer.ts:50–57](../src/shared/services/file-writer.ts#L50)) and the reader's `pathForComponent` ([file-reader.ts:51–63](../src/shared/services/file-reader.ts#L51)) compute identical paths for the same `(componentType, componentName, dataspaceName)`. The writer's own comment states the intent ([file-writer.ts:40–41](../src/shared/services/file-writer.ts#L40)):

> Folder-name derivation lives in the shared path module so the writer and reader use the identical function (deploy finds exactly what retrieve wrote).

### The reader is tolerant about root-routing

The reader doesn't blindly trust the dataspace context it was handed. It tries the **root path first, then the dataspace path** ([file-reader.ts:72–82](../src/shared/services/file-reader.ts#L72)):

```ts
function candidatePaths(
  componentType: string,
  componentName: string,
  dataspaceName: string,
  baseDir: string
): string[] {
  // Validates the type and yields the canonical (writer) path.
  const canonical = pathForComponent(componentType, componentName, dataspaceName, baseDir);
  const rootPath = join(baseDir, ROOT_DIR, folderForComponentType(componentType), `${componentName}.json`);
  return canonical === rootPath ? [rootPath] : [rootPath, canonical];
}
```

So a component that was written at the root (dataspace-agnostic, or written with no dataspace) is still found even when a dataspace context is passed at deploy time. For a truly root-routed type the two candidates coincide and the root is the only one tried.

### The required-field check and the `''` normalization

When the reader parses a file, it enforces the five required fields ([file-reader.ts:39–40](../src/shared/services/file-reader.ts#L39), [:149–157](../src/shared/services/file-reader.ts#L149)):

```ts
const REQUIRED_FIELDS = ['componentType', 'componentName', 'dataspaceName', 'dependsOn', 'entityPayload'];
// ...
const obj = parsed as Record<string, unknown>;
for (const field of REQUIRED_FIELDS) {
  if (!(field in obj) || obj[field] === undefined) {
    throw new SfError(
      `Component file at "${filePath}" is invalid: missing required field "${field}".`,
      'InvalidComponentFileError'
    );
  }
}
```

This is precisely why the writer normalizes `dataspaceName` to `''` (§5): a root-routed component genuinely has no dataspace, but the field must still be present and not `undefined`, or this check would reject the file. The two behaviors are two ends of the same contract.

### `entityPayload` round-trips byte-for-byte

- The **writer** places `entityPayload: component.entityPayload` verbatim into the serialized object ([file-writer.ts:93](../src/shared/services/file-writer.ts#L93)) — no transform.
- The **reader** returns the parsed object as-is: `return parsed as ComponentFile;` ([file-reader.ts:159](../src/shared/services/file-reader.ts#L159)) — it validates the _presence_ of the five fields but never re-parses or rewrites `entityPayload`.

The type contract seals the intent: `entityPayload` is "Stored verbatim and never re-parsed, so it round-trips byte-for-byte on deploy" ([file-layout.ts:39–40](../src/shared/types/file-layout.ts#L39)). Whatever JSON value the API returned (object or string) survives retrieve → disk → deploy unchanged.

### Dependency walking (how deploy re-assembles the graph)

`deploy` doesn't read a single file — it reads the named root, then walks its `dependsOn` edges transitively, reading each dependency's file, via `collectTransitiveDependencies` ([file-reader.ts:173–228](../src/shared/services/file-reader.ts#L173)). Each edge is resolved by `readComponentFile(dep.componentType, dep.componentName, dataspaceName, options)` ([file-reader.ts:202](../src/shared/services/file-reader.ts#L202)) — the same routing again — so the walker finds each dependency exactly where retrieve wrote it. The walk is dedup'd by `"componentType:componentName"` and cycle-safe (roots are pre-seeded into `visited`, [file-reader.ts:222–224](../src/shared/services/file-reader.ts#L222)). If a listed dependency has no file on disk, the reader raises a structured, actionable `SfError('DependencyNotFoundError')` naming both the missing dep and its referrer ([file-reader.ts:204–210](../src/shared/services/file-reader.ts#L204)).

### Structured errors on the read side

Every failure mode is a structured `SfError` with an actionable message — never a raw gack or "contact support":

| Code                        | Raised at                                                                                                                                      | When                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `InvalidComponentTypeError` | `folderForComponentType` — [component-paths.ts:81–84](../src/shared/constants/component-paths.ts#L81)                                          | type empty / blank / all-punctuation                                                       |
| `ComponentNotFoundError`    | `readComponentFile` — [file-reader.ts:128–132](../src/shared/services/file-reader.ts#L128)                                                     | file absent at every candidate path (message says "Run \"sf data-cloud retrieve\" first.") |
| `InvalidComponentFileError` | `readComponentFile` — [file-reader.ts:146](../src/shared/services/file-reader.ts#L146), [:152–155](../src/shared/services/file-reader.ts#L152) | file is not valid JSON, or a required field is missing/`undefined`                         |
| `DependencyNotFoundError`   | `collectTransitiveDependencies` — [file-reader.ts:205–210](../src/shared/services/file-reader.ts#L205)                                         | a `dependsOn` dep's file is missing on disk                                                |

---

## 8. Extending `DATASPACE_AGNOSTIC_TYPES`

The set of dataspace-agnostic (root-routed) types is designed to grow. It is a `Set<string>` precisely so that adding an org-level type is a one-line change ([component-paths.ts:89–93](../src/shared/constants/component-paths.ts#L89)):

```ts
export const DATASPACE_AGNOSTIC_TYPES = new Set<string>(['DataLakeObject']);
```

### To make a new type root-routed

Add its API `componentType` value to the set:

```ts
export const DATASPACE_AGNOSTIC_TYPES = new Set<string>(['DataLakeObject', 'DataConnection']);
```

That single edit is enough. Because `isRootRouted` is the single source of truth consulted by both the writer and the reader ([file-writer.ts:53](../src/shared/services/file-writer.ts#L53), [file-reader.ts:59](../src/shared/services/file-reader.ts#L59)), every component of that type will now be written to — and read from — the `data-cloud/` root instead of a dataspace subfolder. No writer change, no reader change, no other file touched. The module doc calls out that "keeping the rule here makes it trivial to reverse" ([component-paths.ts:100](../src/shared/constants/component-paths.ts#L100)) — the same is true for adding.

### New types get a folder for free — even without touching the set

Adding to `DATASPACE_AGNOSTIC_TYPES` only changes _routing_ (root vs. dataspace). A brand-new component type doesn't need to be in the set — or anywhere — to get a correct **folder**. Because `folderForComponentType` derives the folder name at runtime with no catalog and no overrides (§3), the moment the backend starts returning a new type, retrieve writes it to a correctly kebab-cased, pluralized folder automatically. This is verified by the test at [component-paths.test.ts:95–97](../test/shared/constants/component-paths.test.ts#L95):

```ts
it('derives a folder for a brand-new backend type with zero CLI changes', () => {
  expect(folderForComponentType('DataMesh')).to.equal('data-meshes');
});
```

So the extension story splits cleanly in two:

| You want…                                      | Do this                                         | Cost             |
| ---------------------------------------------- | ----------------------------------------------- | ---------------- |
| A new type stored **under a dataspace** folder | Nothing — folder derives automatically          | Zero CLI changes |
| A new type stored **at the root** (org-level)  | Add its API value to `DATASPACE_AGNOSTIC_TYPES` | One line         |

This is the concrete realization of the "write generically, extend for free" principle — see [docs/DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md).

---

## Related docs

- **[docs/API_CONTRACT.md](API_CONTRACT.md)** — the wire/Connect API contracts (endpoints, request/response shapes, the `entityPayload` wrapping on deploy).
- **[docs/DESIGN_PRINCIPLES.md](DESIGN_PRINCIPLES.md)** — the _why_ behind the invariants (deterministic names, human-readable JSON, flat-by-type layout, runtime folder derivation).

---

## Appendix: code-vs-doc discrepancies flagged in this document

1. **DLO folder is derived, not hardcoded.** CLAUDE.md / PROJECT_KNOWLEDGE describe `data-cloud/data-lake-objects/` as the DLO location. The code produces that exact path but via `folderForComponentType('DataLakeObject')` — there is no `data-lake-objects` string literal in the source. (§3)
2. **Fixture `dataspaceName` vs. on-disk routing.** The shipped fixture stamps `dataspaceName` on _every_ component including the DLO ([retrieve-api-response.mock.ts:93](../src/shared/mocks/retrieve-api-response.mock.ts#L93)), yet the DLO is written to the root. This is correct: the payload's `dataspaceName` and the file's on-disk location can differ because `isRootRouted` — not the payload — decides placement. (§1, §2)
