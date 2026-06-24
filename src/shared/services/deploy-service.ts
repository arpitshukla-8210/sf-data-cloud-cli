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

import { randomUUID } from 'node:crypto';
import { Connection, SfError } from '@salesforce/core';
import { DeployResult, DeployApiRequest, DeployApiResponse, DeploymentLifecycleStatus } from '../types/deploy.js';
import { ComponentFile } from '../types/file-layout.js';
import { readComponentFile, collectTransitiveDependencies } from './file-reader.js';
import { createPromotion } from './devops-api.js';
import { emitTelemetry, safeComponentType } from './telemetry.js';

/*
 * Orchestrator for `sf data-cloud deploy` (PROJECT_KNOWLEDGE.md §2.3, §5.6, §6.1). Mirrors
 * retrieve-service: parse the flag, read the named local file, walk transitive deps, assemble the
 * deploy request payload, POST it to the Connect API, and return DeployResult. The
 * src/shared/mocks/deploy.mock.ts fixture is retained for offline testing.
 */

/**
 * Parses the TYPE:NAME `--component` flag into its parts. Exported for unit testing.
 *
 * @throws SfError('InvalidComponentFlagError') when the value is not TYPE:NAME.
 */
export function parseComponentFlag(component: string): { componentType: string; componentName: string } {
  const colonIndex = component.indexOf(':');
  if (colonIndex <= 0 || colonIndex >= component.length - 1) {
    throw new SfError(
      `Invalid --component format "${component}". Expected TYPE:NAME (e.g., CalculatedInsight:highValueCustomer).`,
      'InvalidComponentFlagError'
    );
  }
  return {
    componentType: component.substring(0, colonIndex),
    componentName: component.substring(colonIndex + 1),
  };
}

/**
 * Assembles the POST /ssot/devops/component/promotion request body from collected on-disk components (§5.6): a
 * bare ARRAY of components, each carried through verbatim. The payload stays under `entityPayload`
 * (never re-parsed — a string stays a string, an object stays an object, per §5.6 Challenges) and
 * `dataspaceName` is kept per-component (no top-level wrapper). Exported so the transform is directly
 * unit-testable.
 */
export function assembleDeployRequest(components: ComponentFile[]): DeployApiRequest {
  return components.map((file) => ({
    componentType: file.componentType,
    componentName: file.componentName,
    dataspaceName: file.dataspaceName,
    dependsOn: file.dependsOn,
    entityPayload: file.entityPayload,
  }));
}

/**
 * Deploys a component and its transitive dependencies (§6.1): parse the flag, read the named
 * component, walk dependsOn, assemble the request, POST it to the Connect API, and return the
 * submission result. The live backend returns only { status: 'SUBMITTED' } (no jobId yet).
 *
 * @param conn - the authenticated org connection (resolved from --target-org by the command).
 * @param component - the user-requested component in TYPE:NAME form.
 * @param dataspace - developer name of the dataspace context.
 * @param options - `baseDir` is the directory the `data-cloud/` tree is read from (defaults to cwd).
 */
export async function deployComponents(
  conn: Connection,
  component: string,
  dataspace: string,
  options?: { baseDir?: string }
): Promise<DeployResult> {
  // Telemetry (§2.4): one event per call, success and failure. `void` keeps it off the latency path
  // and the helper never throws, so neither the return value nor error propagation is affected.
  const startedAt = Date.now();
  // Client-generated CLI-side trace id for this deploy (§2.4). Emitted in telemetry now that the
  // deploy backend is live; sending it as a request header is deferred until that contract exists.
  const correlationId = randomUUID();
  let componentType = 'unknown'; // bounded TYPE only; set after parse. Never the component name.
  let componentCount = 0;
  try {
    const baseDir = options?.baseDir ?? process.cwd();

    const parsed = parseComponentFlag(component);
    componentType = safeComponentType(parsed.componentType);

    const rootComponent = await readComponentFile(parsed.componentType, parsed.componentName, dataspace, { baseDir });
    const allComponents = await collectTransitiveDependencies([rootComponent], dataspace, { baseDir });
    componentCount = allComponents.length;

    const request = assembleDeployRequest(allComponents);

    const api: DeployApiResponse = await createPromotion(conn, request);
    // The backend always returns a tracking jobId alongside the submission status.
    const result: DeployResult = {
      jobId: api.jobId,
      status: api.status as DeploymentLifecycleStatus,
    };

    const dependencyCount = componentCount > 0 ? componentCount - 1 : 0;
    void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_COMPONENT', {
      correlationId,
      componentType,
      success: true,
      componentCount,
      dependencyCount,
      hadDependencies: dependencyCount > 0,
      lifecycleStatus: result.status, // 'SUBMITTED' on the live synchronous response (§5.6).
      durationMs: Date.now() - startedAt,
    });

    return result;
  } catch (err) {
    void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_COMPONENT', {
      correlationId,
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
