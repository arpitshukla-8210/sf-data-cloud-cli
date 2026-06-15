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

import { Connection, SfError } from '@salesforce/core';
import { RetrieveResult } from '../types/retrieve.js';
import { writeRetrievedComponents } from './file-writer.js';
import { parseComponentFlag } from './deploy-service.js';
import { getSnapshot } from './devops-api.js';
import { emitTelemetry, safeComponentType } from './telemetry.js';

/*
 * Orchestrator for `sf data-cloud retrieve` (PROJECT_KNOWLEDGE.md §2.3, §5.5). Sits between the thin
 * command and the file-writer: it fetches the raw retrieve response from the snapshot endpoint,
 * persists every component to disk in the §5.2 layout, then strips the per-component payloads and
 * returns the standardized RetrieveResult the command renders. Keeping this seam here means the HTTP
 * boundary (devops-api) and the file-writer are the only collaborators — the command stays thin.
 */

/**
 * Retrieves a component and its server-resolved dependency graph, writes each component to the
 * local `data-cloud/` tree, and returns the standardized result (no raw payloads).
 *
 * @param conn - authenticated connection to the source org.
 * @param component - the user-requested component in TYPE:NAME form, echoed back as targetComponent.
 * @param dataspace - developer name of the dataspace the retrieve is scoped to.
 * @param options - optional settings; `baseDir` is the directory the `data-cloud/` tree is written under (defaults to the current working directory, so tests can target a throwaway directory).
 */
export async function retrieveComponents(
  conn: Connection,
  component: string,
  dataspace: string,
  options?: { baseDir?: string }
): Promise<RetrieveResult> {
  // Telemetry (§2.4): one event per call, success and failure. `void` keeps it off the latency path
  // and the helper never throws, so neither the return value nor error propagation is affected.
  const startedAt = Date.now();
  let componentType = 'unknown'; // bounded TYPE only; set after parse. Never the component name.
  let componentCount = 0;
  try {
    // Split the TYPE:NAME flag into the snapshot query parts (reuses deploy's validated parser).
    const parsed = parseComponentFlag(component);
    componentType = safeComponentType(parsed.componentType);

    // The snapshot endpoint returns the named component plus its server-spidered, deployment-ordered
    // dependency graph, with per-component payloads (§5.5).
    const api = await getSnapshot(conn, parsed.componentType, parsed.componentName, dataspace);
    componentCount = api.components.length;

    // Persist every component to disk (§5.2) plus the root manifest (§5.8). Silently overwrites.
    await writeRetrievedComponents(api.components, { baseDir: options?.baseDir ?? process.cwd() });

    // Strip the raw payloads: the standardized result (and --json output) never carries entityPayload.
    const retrievedComponents = api.components.map((c) => ({
      componentType: c.componentType,
      componentName: c.componentName,
      dataspaceName: c.dataspaceName,
      dependsOn: c.dependsOn,
    }));

    const result: RetrieveResult = {
      dataspace,
      targetComponent: component,
      retrievedComponents,
      fileWriteLocation: `./data-cloud/${dataspace}/`,
    };

    const dependencyCount = componentCount > 0 ? componentCount - 1 : 0;
    void emitTelemetry('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT', {
      componentType,
      success: true,
      componentCount,
      dependencyCount,
      hadDependencies: dependencyCount > 0,
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (err) {
    void emitTelemetry('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT', {
      componentType,
      success: false,
      componentCount: 0,
      dependencyCount: 0,
      hadDependencies: false,
      durationMs: Date.now() - startedAt,
      errorCode: err instanceof SfError ? err.code : 'UnexpectedError',
    });
    throw err; // re-throw the ORIGINAL error object — propagation unchanged.
  }
}
