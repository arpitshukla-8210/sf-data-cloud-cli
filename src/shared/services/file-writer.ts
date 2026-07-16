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
import { dirname, join, relative } from 'node:path';
import { RawRetrievedComponent } from '../types/retrieve.js';
import { ComponentFile, Manifest, ManifestEntry } from '../types/file-layout.js';
import { folderForComponentType, isRootRouted, ROOT_DIR, MANIFEST_FILE } from '../constants/component-paths.js';
import { getDiagLogger } from '../diagnostics/logger.js';
import { Subsystem } from '../diagnostics/event.js';

/*
 * The local diagnostic `extra` keys below use snake_case by design — the on-disk NDJSON row schema
 * (event.ts) is a stable log-ingest contract whose field names match the remote telemetry fields, so
 * a support engineer can grep the local log with the same names they see in App Insights.
 */
/* eslint-disable camelcase */

/*
 * Pure file-writing engine for `sf data-cloud retrieve` (PROJECT_KNOWLEDGE.md §5.1, §5.2, §5.8).
 * Takes the raw API components, writes one self-describing JSON file per component into the
 * flat-by-type, dataspace-aware `data-cloud/` tree, then writes the root manifest. Deterministic
 * file names, human-readable indented JSON, `entityPayload` carried through verbatim — no DataKit
 * internals. Writes are idempotent (re-retrieve silently overwrites). No network, no org contact.
 */

// Folder-name derivation lives in the shared path module so the writer and reader use the identical
// function (deploy finds exactly what retrieve wrote). Re-exported for backward-compatible imports.
export { folderForComponentType } from '../constants/component-paths.js';

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

  // Local diagnostic channel (passive observer). One gated TRACE per planned file — home-scrubbed,
  // baseDir-relative paths only, and the `extra` bag is built solely when TRACE is active for FILEIO.
  const diag = getDiagLogger();
  if (diag.traceEnabled(Subsystem.FILEIO)) {
    for (const file of plannedFiles) {
      diag.trace(Subsystem.FILEIO, 'FILE_WRITE', 'writing component file', {
        relative_path: relative(options.baseDir, file.path),
      });
    }
  }

  // Component files first (mkdir(recursive) tolerates the shared dirs), then the manifest.
  await Promise.all(plannedFiles.map((file) => writeJsonFile(file.path, file.content)));
  await writeJsonFile(manifestPath, serialize({ deploymentOrder }));

  return { filesWritten: plannedFiles.map((file) => file.path), manifestPath };
}
