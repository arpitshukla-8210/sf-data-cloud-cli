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
import { RetrieveResult } from '../types/retrieve.js';
import { getDiagLogger } from '../diagnostics/logger.js';
import { Subsystem } from '../diagnostics/event.js';
import { writeRetrievedComponents } from './file-writer.js';
import { parseComponentFlag } from './deploy-service.js';
import { getSnapshot } from './devops-api.js';
import { emitTelemetry, safeComponentType, safeOrgId, errorMessageFrom, extractGackId } from './telemetry.js';

/*
 * The local diagnostic `extra` keys below use snake_case by design — the on-disk NDJSON row schema
 * (event.ts) is a stable log-ingest contract whose field names match the remote telemetry fields, so
 * a support engineer can grep the local log with the same names they see in App Insights. The
 * camelCase telemetry attributes in the same file stay valid camelCase and are unaffected.
 */
/* eslint-disable camelcase */

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
 * @param dataspace - developer name of the dataspace the retrieve is scoped to; omitted scopes to the org's default dataspace.
 * @param options - optional settings; `baseDir` is the directory the `data-cloud/` tree is written under (defaults to the current working directory, so tests can target a throwaway directory).
 */
export async function retrieveComponents(
  conn: Connection,
  component: string,
  dataspace?: string,
  options?: { baseDir?: string }
): Promise<RetrieveResult> {
  // Telemetry (§2.4): one event per call, success and failure. `void` keeps it off the latency path
  // and the helper never throws, so neither the return value nor error propagation is affected.
  const startedAt = Date.now();
  // Client-generated CLI-side trace id for the whole retrieve operation (§2.4). Emitted in telemetry
  // now; threading it as a request header to Connect API -> DataKit awaits the backend contract.
  const correlationId = randomUUID();
  // Local diagnostic channel (passive observer, separate from telemetry). Reuse the orchestrator's
  // correlationId so the on-disk logs join to the telemetry events by one id.
  const diag = getDiagLogger().begin({ command: 'data-cloud retrieve', correlationId });
  // The org this retrieve runs against — mirrors the remote telemetry `orgId`. Computed once
  // (guarded, never throws) and reused across the diagnostic events and telemetry below.
  const orgId = safeOrgId(conn);
  let componentType = 'unknown'; // bounded TYPE only; set after parse. Never the component name.
  let componentCount = 0;
  try {
    // Split the TYPE:NAME flag into the snapshot query parts (reuses deploy's validated parser).
    const parsed = parseComponentFlag(component);
    componentType = safeComponentType(parsed.componentType);
    diag.info(Subsystem.API, 'RETRIEVE_START', 'retrieve started', {
      component_type: componentType,
      ...(orgId && { org_id: orgId }),
    });

    // The snapshot endpoint returns the named component plus its server-spidered, deployment-ordered
    // dependency graph, with per-component payloads (§5.5). Pass our correlationId so the (future)
    // request header matches the id emitted in telemetry below.
    const api = await getSnapshot(conn, parsed.componentType, parsed.componentName, dataspace, correlationId);
    componentCount = api.components.length;
    diag.debug(Subsystem.API, 'RETRIEVE_PARSE', 'snapshot received', { component_count: componentCount });

    diag.debug(Subsystem.FILEIO, 'RETRIEVE_WRITE', 'writing components to disk', { component_count: componentCount });
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
      // Empty when no dataspace was given; components then route to the data-cloud/ root (§5.2).
      dataspace: dataspace ?? '',
      targetComponent: component,
      retrievedComponents,
      fileWriteLocation: dataspace ? `./data-cloud/${dataspace}/` : './data-cloud/',
    };

    const dependencyCount = componentCount > 0 ? componentCount - 1 : 0;
    void emitTelemetry('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT', {
      correlationId,
      componentType,
      ...(orgId && { orgId }),
      success: true,
      componentCount,
      dependencyCount,
      hadDependencies: dependencyCount > 0,
      durationMs: Date.now() - startedAt,
    });
    diag.info(Subsystem.API, 'RETRIEVE_COMPLETE', 'retrieve finished', {
      duration_ms: Date.now() - startedAt,
      component_count: componentCount,
      ...(orgId && { org_id: orgId }),
    });

    return result;
  } catch (err) {
    const errorMessage = errorMessageFrom(err);
    const gackId = extractGackId(errorMessage);
    void emitTelemetry('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT', {
      correlationId,
      componentType,
      ...(orgId && { orgId }),
      success: false,
      componentCount: 0,
      dependencyCount: 0,
      hadDependencies: false,
      durationMs: Date.now() - startedAt,
      errorCode: err instanceof SfError ? err.code : 'UnexpectedError',
      ...(errorMessage && { errorMessage }),
      ...(gackId && { gackId }),
    });
    diag.error(Subsystem.API, 'RETRIEVE_ERR', 'retrieve failed', {
      duration_ms: Date.now() - startedAt,
      error_code: err instanceof SfError ? err.code : 'UnexpectedError',
      ...(errorMessage && { error_message: errorMessage }),
      ...(orgId && { org_id: orgId }),
      err,
    });
    throw err; // re-throw the ORIGINAL error object — propagation unchanged.
  }
}
