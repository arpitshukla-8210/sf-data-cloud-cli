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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SfError } from '@salesforce/core';
import { ComponentFile } from '../types/file-layout.js';
import { FOLDER_BY_TYPE, isRootRouted, ROOT_DIR } from '../constants/component-paths.js';

/*
 * Pure file-reading engine for `sf data-cloud deploy` (PROJECT_KNOWLEDGE.md §5.2, §6.1). The inverse
 * of file-writer: reads component JSON files and walks the dependency graph. Uses the same shared
 * path constants so the reader finds files exactly where the writer put them. No network, no org
 * contact; payloads are returned verbatim and never re-parsed.
 */

/** API fields a valid on-disk component file must carry (§5.1). */
const REQUIRED_FIELDS = ['componentType', 'componentName', 'dataspaceName', 'dependsOn', 'entityPayload'];

/**
 * Computes the canonical absolute on-disk path for a component (§5.2) — where the file-writer puts
 * it. Root-routed components (DLOs, or any with an empty/absent dataspaceName) live at
 * `<baseDir>/data-cloud/<folder>/<name>.json`; all others at
 * `<baseDir>/data-cloud/<dataspaceName>/<folder>/<name>.json`.
 *
 * @throws SfError('UnknownComponentTypeError') when the type has no known folder.
 */
export function pathForComponent(
  componentType: string,
  componentName: string,
  dataspaceName: string,
  baseDir: string
): string {
  if (!Object.hasOwn(FOLDER_BY_TYPE, componentType)) {
    throw new SfError(
      `Unknown component type "${componentType}". Supported types: ${Object.keys(FOLDER_BY_TYPE).join(', ')}.`,
      'UnknownComponentTypeError'
    );
  }
  const folder = FOLDER_BY_TYPE[componentType];
  const fileName = `${componentName}.json`;
  if (isRootRouted(componentType, dataspaceName)) {
    return join(baseDir, ROOT_DIR, folder, fileName);
  }
  return join(baseDir, ROOT_DIR, dataspaceName, folder, fileName);
}

/**
 * Ordered candidate paths to read a component from, ROOT FIRST then the dataspace path (§6.1). A
 * component stored without a dataspace (at the root) is therefore found even when a dataspace
 * context is passed; for root-routed types the root is the only candidate.
 *
 * @throws SfError('UnknownComponentTypeError') when the type has no known folder.
 */
function candidatePaths(
  componentType: string,
  componentName: string,
  dataspaceName: string,
  baseDir: string
): string[] {
  // Validates the type and yields the canonical (writer) path.
  const canonical = pathForComponent(componentType, componentName, dataspaceName, baseDir);
  const rootPath = join(baseDir, ROOT_DIR, FOLDER_BY_TYPE[componentType], `${componentName}.json`);
  return canonical === rootPath ? [rootPath] : [rootPath, canonical];
}

/**
 * Reads and parses a single component file from disk, returning the full ComponentFile (including
 * the verbatim entityPayload needed for deploy assembly).
 *
 * @throws SfError('ComponentNotFoundError') when the file does not exist at its expected path.
 * @throws SfError('InvalidComponentFileError') when the file is not valid JSON or lacks a required field.
 */
export async function readComponentFile(
  componentType: string,
  componentName: string,
  dataspaceName: string,
  options: { baseDir: string }
): Promise<ComponentFile> {
  // Try the root path first, then the dataspace path (§6.1): a component stored without a dataspace
  // is found even when a dataspace context is passed. On a miss we report the canonical writer
  // location (the last candidate) — where `retrieve` would have placed this type/dataspace.
  const candidates = candidatePaths(componentType, componentName, dataspaceName, options.baseDir);
  const canonicalPath = candidates[candidates.length - 1];

  let raw: string | undefined;
  let filePath: string | undefined;
  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      raw = await readFile(candidate, 'utf8');
      filePath = candidate;
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        continue; // Not here — try the next candidate.
      }
      throw err; // Permission errors, etc. — propagate unchanged.
    }
  }

  if (raw === undefined || filePath === undefined) {
    throw new SfError(
      `Component "${componentType}:${componentName}" not found at expected path: ${canonicalPath}. ` +
        'Run "sf data-cloud retrieve" first.',
      'ComponentNotFoundError'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SfError(`Component file at "${filePath}" contains invalid JSON.`, 'InvalidComponentFileError');
  }

  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj) || obj[field] === undefined) {
      throw new SfError(
        `Component file at "${filePath}" is invalid: missing required field "${field}".`,
        'InvalidComponentFileError'
      );
    }
  }

  return parsed as ComponentFile;
}

/**
 * Starting from root component(s), walks `dependsOn` edges (depth-first, concurrently) reading each
 * dependency's file from disk (§6.1). Deduplicates by "componentType:componentName"; cycle-safe.
 * Returns ALL collected components (roots + transitive deps). The server computes the final
 * topological deploy order (§6.2 Step 3), so discovery order here is irrelevant.
 *
 * Dedup is race-free despite concurrency: each key is added to `visited` synchronously, before its
 * `await`, and JS runs that check-and-add atomically.
 *
 * @throws SfError('DependencyNotFoundError') when a dep listed in dependsOn has no file on disk.
 */
export async function collectTransitiveDependencies(
  roots: ComponentFile[],
  dataspaceName: string,
  options: { baseDir: string }
): Promise<ComponentFile[]> {
  const visited = new Set<string>();
  const collected: ComponentFile[] = [];

  const visit = async (component: ComponentFile): Promise<void> => {
    collected.push(component);
    await Promise.all(
      component.dependsOn.map(async (dep) => {
        const depKey = `${dep.componentType}:${dep.componentName}`;
        if (visited.has(depKey)) {
          return;
        }
        visited.add(depKey);

        let depFile: ComponentFile;
        try {
          depFile = await readComponentFile(dep.componentType, dep.componentName, dataspaceName, options);
        } catch (err: unknown) {
          if (err instanceof SfError && err.code === 'ComponentNotFoundError') {
            throw new SfError(
              `Dependency "${dep.componentType}:${dep.componentName}" (referenced by ` +
                `"${component.componentType}:${component.componentName}") not found on disk. ` +
                'Run "sf data-cloud retrieve" to fetch the full dependency graph.',
              'DependencyNotFoundError'
            );
          }
          throw err;
        }
        await visit(depFile);
      })
    );
  };

  // Pre-seed roots into `visited` so any edge pointing AT a root is skipped: cycles
  // (a dep loops back to a root) and the case where one root is a dependency of another.
  // Shared NON-root deps are deduped separately by the visited.add below.
  for (const root of roots) {
    visited.add(`${root.componentType}:${root.componentName}`);
  }
  await Promise.all(roots.map((root) => visit(root)));

  return collected;
}
