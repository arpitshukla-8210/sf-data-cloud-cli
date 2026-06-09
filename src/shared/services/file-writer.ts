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

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SfError } from '@salesforce/core';
import { RawRetrievedComponent } from '../types/retrieve.js';
import { ComponentFile, Manifest, ManifestEntry } from '../types/file-layout.js';

/*
 * Pure file-writing engine for `sf data-cloud retrieve` (PROJECT_KNOWLEDGE.md §5.1, §5.2, §5.8).
 * Takes the raw API components, writes one self-describing JSON file per component into the
 * flat-by-type, dataspace-aware `data-cloud/` tree, then writes the root manifest. Deterministic
 * file names, human-readable indented JSON, normalized `entityPayload` key — no DataKit internals.
 * Writes are idempotent (re-retrieve silently overwrites). No network, no org contact.
 */

/** Component type -> kebab-case, plural folder name (§5.2). Generic across all supported types. */
const FOLDER_BY_TYPE: Record<string, string> = {
  CalculatedInsight: 'calculated-insights',
  DataModelObject: 'data-model-objects',
  DataTransform: 'data-transforms',
  DataLakeObject: 'data-lake-objects',
  IdentityResolution: 'identity-resolutions',
  SegmentDefinition: 'segments',
  DataStream: 'data-streams',
  DataConnection: 'data-connections',
  DataAction: 'data-actions',
};

/**
 * Types whose definitions are dataspace-agnostic (org-level) and therefore live at the
 * `data-cloud/` root, OUTSIDE any dataspace folder (§5.2). A Set so this stays extensible.
 */
const DATASPACE_AGNOSTIC_TYPES = new Set<string>(['DataLakeObject']);

/** Root directory all retrieve artifacts are written under, relative to the chosen base directory. */
const ROOT_DIR = 'data-cloud';

/** Manifest file name at the root of the `data-cloud/` tree (§5.8). */
const MANIFEST_FILE = 'manifest.json';

/** Narrows an unknown value to a plain (non-array) object so its keys can be inspected safely. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Maps a component type to its on-disk folder name (§5.2). Throws a structured error for an
 * unsupported type rather than silently writing to a bad path.
 */
export function folderForComponentType(componentType: string): string {
  if (!Object.hasOwn(FOLDER_BY_TYPE, componentType)) {
    throw new SfError(
      `Unknown component type "${componentType}". Supported types: ${Object.keys(FOLDER_BY_TYPE).join(', ')}.`,
      'UnknownComponentTypeError'
    );
  }
  return FOLDER_BY_TYPE[componentType];
}

/**
 * Resolves the single, type-specific payload from a raw component, normalizing the inconsistent
 * API shape (§5.1, §5.5). Precedence: use `entitypayload` (lowercase) when present and non-null;
 * otherwise fall back to `data`, unwrapping `data.entityPayload` when `data` is an object that wraps
 * it, else using `data` verbatim; otherwise the component has no payload (a structured error).
 * `null` is treated as "absent" so a present-but-empty `entitypayload` falls through to `data`.
 * Returns the payload unchanged (object or string); it is written verbatim and never re-parsed.
 */
export function normalizeEntityPayload(raw: RawRetrievedComponent): unknown {
  if (raw.entitypayload !== undefined && raw.entitypayload !== null) {
    return raw.entitypayload;
  }
  if (raw.data !== undefined && raw.data !== null) {
    if (isRecord(raw.data) && 'entityPayload' in raw.data) {
      return raw.data.entityPayload;
    }
    return raw.data;
  }
  throw new SfError(
    `Component "${raw.componentName}" (${raw.componentType}) has no payload (neither "entitypayload" nor "data" was present).`,
    'MissingPayloadError'
  );
}

/**
 * Computes the absolute on-disk path for a component (§5.2). Dataspace-agnostic types (DLOs) route
 * to `<baseDir>/data-cloud/<folder>/<name>.json` (root); all others to
 * `<baseDir>/data-cloud/<dataspaceName>/<folder>/<name>.json`.
 */
function pathForComponent(component: RawRetrievedComponent, baseDir: string): string {
  const folder = folderForComponentType(component.componentType);
  const fileName = `${component.componentName}.json`;
  if (DATASPACE_AGNOSTIC_TYPES.has(component.componentType)) {
    return join(baseDir, ROOT_DIR, folder, fileName);
  }
  return join(baseDir, ROOT_DIR, component.dataspaceName, folder, fileName);
}

/** Serializes any on-disk artifact as human-readable, 2-space-indented JSON with a trailing newline. */
function serialize(value: ComponentFile | Manifest): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Writes one file, creating its parent directory tree first. mkdir(recursive) is idempotent. */
async function writeJsonFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/**
 * Persists every retrieved component to disk in the §5.2 layout and writes the root manifest
 * (§5.8). Each component's normalized payload and target path are resolved up front (preserving
 * response order), so any unsupported type / missing payload fails before a single file is written.
 * The manifest lists ALL components (including DLOs) in the same server-provided deployment order.
 * Existing files/directories are silently overwritten.
 *
 * @returns the absolute paths written, in response order, plus the manifest path.
 */
export async function writeRetrievedComponents(
  components: RawRetrievedComponent[],
  options: { baseDir: string }
): Promise<{ filesWritten: string[]; manifestPath: string }> {
  // Resolve everything synchronously first: a bad type/payload throws here, before any I/O.
  const plannedFiles = components.map((component) => ({
    path: pathForComponent(component, options.baseDir),
    content: serialize({
      componentType: component.componentType,
      componentName: component.componentName,
      dataspaceName: component.dataspaceName,
      dependsOn: component.dependsOn,
      entityPayload: normalizeEntityPayload(component),
    }),
  }));

  const deploymentOrder: ManifestEntry[] = components.map((component) => ({
    componentType: component.componentType,
    componentName: component.componentName,
    dataspaceName: component.dataspaceName,
  }));
  const manifestPath = join(options.baseDir, ROOT_DIR, MANIFEST_FILE);

  // Component files first (mkdir(recursive) tolerates the shared dirs), then the manifest.
  await Promise.all(plannedFiles.map((file) => writeJsonFile(file.path, file.content)));
  await writeJsonFile(manifestPath, serialize({ deploymentOrder }));

  return { filesWritten: plannedFiles.map((file) => file.path), manifestPath };
}
