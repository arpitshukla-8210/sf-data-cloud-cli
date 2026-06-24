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

/*
 * Shared path-resolution constants for the on-disk `data-cloud/` tree (PROJECT_KNOWLEDGE.md §5.2).
 * Single source of truth used by both the file-writer (retrieve → disk) and the file-reader
 * (disk → deploy), so the reader finds files exactly where the writer put them.
 */

/** Component type -> kebab-case, plural folder name (§5.2). Generic across all supported types. */
export const FOLDER_BY_TYPE: Record<string, string> = {
  CalculatedInsight: 'calculated-insights',
  DataModelObject: 'data-model-objects',
  DataTransform: 'data-transforms',
  DataLakeObject: 'data-lake-objects',
  IdentityResolution: 'identity-resolutions',
  MarketSegment: 'segments',
  DataStreamBundle: 'data-streams',
  DataConnection: 'data-connections',
  DataAction: 'data-actions',
  DataGraph: 'data-graphs',
};

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
