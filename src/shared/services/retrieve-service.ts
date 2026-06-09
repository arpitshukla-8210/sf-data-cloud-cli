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

import { RetrieveResult } from '../types/retrieve.js';
import { getMockRetrieveApiResponse } from '../mocks/retrieve-api-response.mock.js';
import { writeRetrievedComponents } from './file-writer.js';

/*
 * Orchestrator for `sf data-cloud retrieve` (PROJECT_KNOWLEDGE.md §2.3, §5.5). Sits between the thin
 * command and the file-writer: it fetches the raw retrieve response, persists every component to
 * disk in the §5.2 layout, then strips the per-component payloads and returns the standardized
 * RetrieveResult the command renders. Keeping this seam here means wiring the real Connect API in
 * Week 2–3 touches only this module — neither the command nor the file-writer changes.
 */

/**
 * Retrieves a component and its server-resolved dependency graph, writes each component to the
 * local `data-cloud/` tree, and returns the standardized result (no raw payloads).
 *
 * @param component - the user-requested component in TYPE:NAME form, echoed back as targetComponent.
 * @param dataspace - developer name of the dataspace the retrieve is scoped to.
 * @param options - optional settings; `baseDir` is the directory the `data-cloud/` tree is written under (defaults to the current working directory, so tests can target a throwaway directory).
 */
export async function retrieveComponents(
  component: string,
  dataspace: string,
  options?: { baseDir?: string }
): Promise<RetrieveResult> {
  // Source: dummy raw response today; swap for a real Connect API client in Week 2–3.
  // The mock simulates the server's spidered, deployment-ordered response with payloads (§5.5).
  const api = getMockRetrieveApiResponse(dataspace);

  // Persist every component to disk (§5.2) plus the root manifest (§5.8). Silently overwrites.
  await writeRetrievedComponents(api.components, { baseDir: options?.baseDir ?? process.cwd() });

  // Strip the raw payloads: the standardized result (and --json output) never carries entityPayload.
  const retrievedComponents = api.components.map((c) => ({
    componentType: c.componentType,
    componentName: c.componentName,
    dataspaceName: c.dataspaceName,
    dependsOn: c.dependsOn,
  }));

  return {
    dataspace,
    targetComponent: component,
    retrievedComponents,
    fileWriteLocation: `./data-cloud/${dataspace}/`,
  };
}
