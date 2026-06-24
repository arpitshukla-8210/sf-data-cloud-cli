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
import { FOLDER_BY_TYPE, isRootRouted, ROOT_DIR, MANIFEST_FILE } from '../constants/component-paths.js';

/*
 * Pure file-writing engine for `sf data-cloud retrieve` (PROJECT_KNOWLEDGE.md §5.1, §5.2, §5.8).
 * Takes the raw API components, writes one self-describing JSON file per component into the
 * flat-by-type, dataspace-aware `data-cloud/` tree, then writes the root manifest. Deterministic
 * file names, human-readable indented JSON, `entityPayload` carried through verbatim — no DataKit
 * internals. Writes are idempotent (re-retrieve silently overwrites). No network, no org contact.
 */

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
 * Computes the absolute on-disk path for a component (§5.2). Root-routed components (dataspace-
 * agnostic types like DLOs, or any component with an empty/absent dataspaceName) route to
 * `<baseDir>/data-cloud/<folder>/<name>.json`; all others to
 * `<baseDir>/data-cloud/<dataspaceName>/<folder>/<name>.json`.
 */
function pathForComponent(component: RawRetrievedComponent, baseDir: string): string {
  const folder = folderForComponentType(component.componentType);
  const fileName = `${component.componentName}.json`;
  if (isRootRouted(component.componentType, component.dataspaceName)) {
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
  // Normalize a null/absent dataspaceName to '' so the on-disk file stays self-describing and the
  // file-reader's required-field check (which rejects `undefined`) still passes (§5.1).
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

  const deploymentOrder: ManifestEntry[] = components.map((component) => ({
    componentType: component.componentType,
    componentName: component.componentName,
    dataspaceName: component.dataspaceName ?? '',
  }));
  const manifestPath = join(options.baseDir, ROOT_DIR, MANIFEST_FILE);

  // Component files first (mkdir(recursive) tolerates the shared dirs), then the manifest.
  await Promise.all(plannedFiles.map((file) => writeJsonFile(file.path, file.content)));
  await writeJsonFile(manifestPath, serialize({ deploymentOrder }));

  return { filesWritten: plannedFiles.map((file) => file.path), manifestPath };
}
