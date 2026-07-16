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

import { SfError } from '@salesforce/core';

/*
 * Shared path-resolution logic for the on-disk `data-cloud/` tree (PROJECT_KNOWLEDGE.md §5.2).
 * Single source of truth used by both the file-writer (retrieve → disk) and the file-reader
 * (disk → deploy), so the reader finds files exactly where the writer put them.
 *
 * Folder names are DERIVED from the backend `componentType` at runtime (kebab-case + pluralize)
 * rather than looked up in a hardcoded catalog, so a new backend component type gets a correct
 * folder with ZERO CLI changes. Every type — with no exceptions or overrides — flows through the
 * same derivation, so the whole tree follows one consistent kebab-case, PLURAL standard (§5.2).
 */

/**
 * Converts an arbitrary string to a safe, deterministic kebab-case slug. Splits PascalCase and
 * acronym boundaries (`HTTPConnection` → `http-connection`, `DataAPIObject` → `data-api-object`),
 * lower-cases, and collapses every non-alphanumeric run (spaces, `_`, unicode, and path characters
 * like `/`, `\`, `:`, `..`, null bytes) into a single hyphen. Because separators and `..` carry no
 * alphanumerics they collapse/trim away, so a derived folder name can never escape the
 * `data-cloud/` tree. Returns `''` for input with no alphanumeric content (caller decides).
 */
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

/**
 * Pluralizes the LAST hyphen segment of a kebab slug with a minimal English rule set — enough to
 * keep folder names natural for future types without an irregular-plural library. Already-plural
 * ('s') is left alone (idempotent); `s|sh|ch|x|z` → `+es`; consonant + `y` → `…ies`; else `+s`.
 */
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

/**
 * Derives the on-disk folder name for a component type (§5.2): kebab-case, PLURAL. Every type flows
 * through the same kebab+pluralize derivation with no catalog and no overrides, so new backend
 * types work with zero CLI changes. Throws a structured, actionable error only when the type is
 * empty/blank or reduces to nothing after slugifying (e.g. all punctuation) — never for a
 * merely-unknown type.
 */
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

/**
 * Types whose definitions are dataspace-agnostic (org-level) and live at the `data-cloud/` root,
 * OUTSIDE any dataspace folder (§5.2). A Set so this stays extensible.
 */
export const DATASPACE_AGNOSTIC_TYPES = new Set<string>(['DataLakeObject']);

/**
 * Whether a component is stored at the `data-cloud/` root (no dataspace folder) rather than under a
 * `data-cloud/<dataspace>/` subdirectory (§5.2). True for dataspace-agnostic types (e.g.
 * DataLakeObject) AND for any component whose dataspaceName is empty/null/undefined — generalizing
 * the original DLO-only special case. Single source of truth for both the file-writer (retrieve →
 * disk) and the file-reader (disk → deploy); keeping the rule here makes it trivial to reverse.
 */
export function isRootRouted(componentType: string, dataspaceName?: string | null): boolean {
  return DATASPACE_AGNOSTIC_TYPES.has(componentType) || dataspaceName == null || dataspaceName.trim() === '';
}

/** Root directory all retrieve/deploy artifacts live under, relative to the chosen base directory. */
export const ROOT_DIR = 'data-cloud';

/** Manifest file name at the root of the `data-cloud/` tree (§5.8). */
export const MANIFEST_FILE = 'manifest.json';
