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
import { ComponentTypesResponse } from '../types/component-type.js';
import { ComponentsResponse } from '../types/component.js';
import { RetrieveApiResponse } from '../types/retrieve.js';
import { DeployApiRequest, DeployApiResponse } from '../types/deploy.js';
import { emitTelemetry, safeComponentType } from './telemetry.js';

/*
 * Thin client over the Data Cloud DevOps Connect API (PROJECT_KNOWLEDGE.md §1.6, §1.7). This is the
 * single HTTP boundary for the read commands: each function is one `Connection.request` call against
 * `/ssot/devops/*`, with the API version resolved from the connection (never hardcoded). Low-level
 * jsforce/connection failures are translated into structured, actionable SfErrors here so callers
 * (commands and services) stay thin and never surface raw gacks (§1.11).
 */

/** Builds the versioned `ssot/devops` base path from the connection's resolved API version. */
const basePath = (conn: Connection): string => `/services/data/v${conn.getApiVersion()}/ssot/devops`;

/**
 * Translates a low-level connection/jsforce error into a structured, actionable SfError.
 *
 * @param err - the caught error (jsforce HttpApiError, SfError, or a raw network Error).
 * @param op - a human phrase describing the attempted operation, e.g. "list component types".
 */
function toSfError(err: unknown, op: string): SfError {
  const e = err as { name?: string; errorCode?: string; message?: string };
  const code = e?.errorCode ?? e?.name ?? '';
  const message = e?.message ?? String(err);
  // SfError's `cause` must be an Error (it throws otherwise), so only forward real Errors.
  const cause = err instanceof Error ? err : undefined;

  if (code === 'DomainNotFoundError' || /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return new SfError(
      `Could not reach the org to ${op}. ${message}`,
      'DataCloudApiNetworkError',
      ['Check your network connection and that the org instance URL is reachable.'],
      undefined,
      cause
    );
  }
  if (code === 'INVALID_SESSION_ID' || code === 'ERROR_HTTP_401') {
    return new SfError(
      `Your session is invalid or expired while trying to ${op}.`,
      'DataCloudApiAuthError',
      ['Re-authenticate with `sf org login web` and try again.'],
      undefined,
      cause
    );
  }
  if (code === 'NOT_FOUND' || code === 'ERROR_HTTP_404') {
    return new SfError(
      `The Data Cloud DevOps API returned 404 while trying to ${op}.`,
      'DataCloudApiNotFoundError',
      [
        'Confirm the org has Data Cloud (Data 360) enabled and the DevOps API is available.',
        'Verify the component type, name, and dataspace are correct.',
      ],
      undefined,
      cause
    );
  }
  return new SfError(`Failed to ${op}: ${message}`, 'DataCloudApiError', undefined, undefined, cause);
}

/**
 * GET /ssot/devops/component-types — the catalog of supported Data Cloud component types (§5.3).
 */
export async function getComponentTypes(conn: Connection): Promise<ComponentTypesResponse> {
  const startedAt = Date.now();
  // Client-generated CLI-side trace id for this request (§2.4). Emitted in telemetry now; sending it
  // as a request header to Connect API -> DataKit is deferred until the backend defines that contract.
  const correlationId = randomUUID();
  try {
    const resp = await conn.request<ComponentTypesResponse>(`${basePath(conn)}/component-types`);
    // No componentType arg for this fn, so the key is omitted from the payload entirely.
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'componentTypes',
      success: true,
      resultCount: Object.keys(resp.supportedComponentTypes).length,
      durationMs: Date.now() - startedAt,
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, 'list component types');
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'componentTypes',
      success: false,
      resultCount: 0,
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code,
    });
    throw mapped;
  }
}

/**
 * GET /ssot/devops/component/catalog?componentType=<>[&dataSpaceName=<>] — the components of a given
 * type, optionally scoped to a dataspace (§5.4). When no dataspace is given the param is omitted and
 * the backend lists across the org's default dataspace context.
 */
export async function getComponents(
  conn: Connection,
  componentType: string,
  dataSpaceName?: string
): Promise<ComponentsResponse> {
  const startedAt = Date.now();
  // Client-generated CLI-side trace id for this request (§2.4). Emitted in telemetry now; sending it
  // as a request header to Connect API -> DataKit is deferred until the backend defines that contract.
  const correlationId = randomUUID();
  // Omit dataSpaceName entirely when absent (never send `dataSpaceName=undefined`).
  const params: Record<string, string> = { componentType };
  if (dataSpaceName?.trim()) {
    params.dataSpaceName = dataSpaceName;
  }
  const qs = new URLSearchParams(params).toString();
  try {
    const resp = await conn.request<ComponentsResponse>(`${basePath(conn)}/component/catalog?${qs}`);
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'components',
      componentType: safeComponentType(componentType), // bounded TYPE only; never the dataspace/qs.
      success: true,
      resultCount: resp.components.length,
      durationMs: Date.now() - startedAt,
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, `list components of type "${componentType}"`);
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'components',
      componentType: safeComponentType(componentType),
      success: false,
      resultCount: 0,
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code,
    });
    throw mapped;
  }
}

/**
 * GET /ssot/devops/component/snapshot?componentType=<>&componentName=<>[&dataSpaceName=<>] — a single
 * named component plus its server-spidered dependency graph, with per-component payloads (§5.5). When
 * no dataspace is given the param is omitted and the backend resolves the org's default dataspace.
 */
export async function getSnapshot(
  conn: Connection,
  componentType: string,
  componentName: string,
  dataSpaceName?: string
): Promise<RetrieveApiResponse> {
  // Omit dataSpaceName entirely when absent (never send `dataSpaceName=undefined`).
  const params: Record<string, string> = { componentType, componentName };
  if (dataSpaceName?.trim()) {
    params.dataSpaceName = dataSpaceName;
  }
  const qs = new URLSearchParams(params).toString();
  try {
    return await conn.request<RetrieveApiResponse>(`${basePath(conn)}/component/snapshot?${qs}`);
  } catch (err) {
    throw toSfError(err, `retrieve snapshot for ${componentType}:${componentName}`);
  }
}

/**
 * POST /ssot/devops/component/promotion — submit a promotion (deploy) of the named component plus its transitive
 * dependencies (§5.6). The deploy runs async; the synchronous body is a submission ack
 * ({ status: 'SUBMITTED', jobId }). Like getSnapshot, this maps errors but emits no telemetry — the
 * orchestration event (with its correlationId) is emitted by deploy-service.
 *
 * Contract (confirmed with backend): the body wraps a `components` array under a top-level object
 * ({ components: [...] }) — each element the exact on-disk snapshot JSON with its payload under
 * `entityPayload` and `dataspaceName` per-component (no top-level dataSpaceName). Mirrors
 * CdpDevOpsComponentPayloadInputRepresentation (getEntityPayload / getDataspaceName), which the
 * handler iterates over input.getComponents().
 */
export async function createPromotion(conn: Connection, request: DeployApiRequest): Promise<DeployApiResponse> {
  try {
    return await conn.request<DeployApiResponse>({
      method: 'POST',
      url: `${basePath(conn)}/component/promotion`,
      body: JSON.stringify({ components: request }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    throw toSfError(err, 'deploy components');
  }
}
