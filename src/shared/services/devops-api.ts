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
import { Env } from '@salesforce/kit';
import { ComponentTypesResponse } from '../types/component-type.js';
import { ComponentsResponse } from '../types/component.js';
import { RetrieveApiResponse } from '../types/retrieve.js';
import { DeployApiRequest, DeployApiResponse } from '../types/deploy.js';
import { DeployStatusApiResponse } from '../types/deploy-status.js';
import { getDiagLogger } from '../diagnostics/logger.js';
import { Subsystem } from '../diagnostics/event.js';
import { getMockComponentTypes } from '../mocks/component-types.mock.js';
import { getMockComponents } from '../mocks/components.mock.js';
import { getMockRetrieveApiResponse } from '../mocks/retrieve-api-response.mock.js';
import { emitTelemetry, safeComponentType, safeOrgId, errorMessageFrom, extractGackId } from './telemetry.js';

/*
 * The local diagnostic `extra` keys below use snake_case by design — the on-disk NDJSON row schema
 * (event.ts) is a stable log-ingest contract whose field names match the remote telemetry fields, so
 * a support engineer can grep the local log with the same names they see in App Insights. The
 * camelCase telemetry attributes in the same file stay valid camelCase and are unaffected.
 */
/* eslint-disable camelcase */

/*
 * Thin client over the Data Cloud DevOps Connect API (PROJECT_KNOWLEDGE.md §1.6, §1.7). This is the
 * single HTTP boundary for the read commands: each function is one `Connection.request` call against
 * `/ssot/devops/*`, with the API version resolved from the connection (never hardcoded). Low-level
 * jsforce/connection failures are translated into structured, actionable SfErrors here so callers
 * (commands and services) stay thin and never surface raw gacks (§1.11).
 */

/** Builds the versioned `ssot/devops` base path from the connection's resolved API version. */
const basePath = (conn: Connection): string => `/services/data/v${conn.getApiVersion()}/ssot/devops`;

/*
 * CLI->backend correlation (§2.4). The client mints one correlationId per operation, emits it in
 * telemetry, AND (once enabled) sends it as a request header so the backend's Connect API / Splunk
 * logs join to the CLI event. The header NAME below is a PLACEHOLDER — the header the Connect API
 * actually reads for request correlation could not be determined from code and MUST be confirmed
 * with the backend owner. Until then SEND_CORRELATION_HEADER stays false: every request is built
 * byte-for-byte as it is today (bare URL string for GETs, Content-Type only for the POST), so no
 * behavior changes and an unrecognized header is never sent. Flipping the flag + setting the real
 * name is the only remaining step. `: boolean` (not the literal) keeps the gate a real runtime check.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
const SEND_CORRELATION_HEADER: boolean = false;

/*
 * Offline-mock gate (opt-in, inert by default). When `SF_DATACLOUD_MOCK` is truthy, the read API
 * functions below return their in-repo fixture instead of calling `conn.request`, so a command can be
 * run end-to-end (service -> file-writer -> output) with no org. Read through @salesforce/kit's `Env`
 * to match how the rest of the plugin reads env config (no raw process.env). `env` is parameterized
 * (mirroring correlationHeaders/getRequest) so a test can force either branch without touching the
 * real environment. NOTE: only the three exact-type-match reads are mocked — deploy (createPromotion)
 * and deploy status (getPromotionStatus) have no type-matching fixture and still hit the real API even
 * when this is on.
 */
export const MOCK_ENV_VAR = 'SF_DATACLOUD_MOCK';
export const mockEnabled = (env: Env = new Env()): boolean => env.getBoolean(MOCK_ENV_VAR);

/**
 * The correlation header as a map when enabled, else empty — spread into an existing headers object.
 * `enabled` defaults to the module gate (off); tests pass `true` to exercise the enabled shape without
 * shipping it on. `: boolean` (not the literal) keeps the branch a real runtime check.
 */
export const correlationHeaders = (
  correlationId: string,
  enabled: boolean = SEND_CORRELATION_HEADER
): Record<string, string> => (enabled ? { [CORRELATION_ID_HEADER]: correlationId } : {});

/**
 * The argument for a GET `conn.request`: a bare URL string today (gate off → behavior unchanged), or
 * an HttpRequest-shaped object carrying the correlation header once the gate is enabled. The `'GET'`
 * literal keeps the object assignable to the connection's `string | HttpRequest` request signature.
 * `enabled` defaults to the module gate; exported + parameterized so the enabled path is unit-testable.
 */
export const getRequest = (
  url: string,
  correlationId: string,
  enabled: boolean = SEND_CORRELATION_HEADER
): string | { method: 'GET'; url: string; headers: Record<string, string> } =>
  enabled ? { method: 'GET', url, headers: correlationHeaders(correlationId, enabled) } : url;

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
export async function getComponentTypes(
  conn: Connection,
  correlationId: string = randomUUID()
): Promise<ComponentTypesResponse> {
  const startedAt = Date.now();
  // Local diagnostic channel (passive observer): reuse the request's correlationId.
  const diag = getDiagLogger().begin({ correlationId });
  // The org this request runs against — mirrors the remote telemetry `orgId`. Computed once (guarded,
  // never throws) and reused across telemetry and the diagnostic events below.
  const orgId = safeOrgId(conn);
  // Client-generated CLI-side trace id for this request (§2.4): emitted in telemetry and, once
  // SEND_CORRELATION_HEADER is enabled, also sent as a request header so the backend logs join to it.
  try {
    // Offline-mock short-circuit (SF_DATACLOUD_MOCK): return the fixture before touching the org.
    if (mockEnabled()) return getMockComponentTypes();
    diag.debug(Subsystem.API, 'API_REQ_START', 'requesting component types', { operation: 'componentTypes' });
    const resp = await conn.request<ComponentTypesResponse>(
      getRequest(`${basePath(conn)}/component-types`, correlationId)
    );
    // No componentType arg for this fn, so the key is omitted from the payload entirely.
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'componentTypes',
      ...(orgId && { orgId }),
      success: true,
      resultCount: Object.keys(resp.supportedComponentTypes).length,
      durationMs: Date.now() - startedAt,
    });
    diag.debug(Subsystem.API, 'API_REQ_END', 'component types received', {
      operation: 'componentTypes',
      result_count: Object.keys(resp.supportedComponentTypes).length,
      duration_ms: Date.now() - startedAt,
      ...(orgId && { org_id: orgId }),
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, 'list component types');
    const errorMessage = errorMessageFrom(mapped);
    const gackId = extractGackId(errorMessage);
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'componentTypes',
      ...(orgId && { orgId }),
      success: false,
      resultCount: 0,
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code,
      ...(errorMessage && { errorMessage }),
      ...(gackId && { gackId }),
    });
    diag.error(Subsystem.API, 'API_REQ_ERR', 'component types request failed', {
      operation: 'componentTypes',
      error_code: mapped.code,
      ...(errorMessage && { error_message: errorMessage }),
      ...(orgId && { org_id: orgId }),
      duration_ms: Date.now() - startedAt,
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
  dataSpaceName?: string,
  correlationId: string = randomUUID()
): Promise<ComponentsResponse> {
  const startedAt = Date.now();
  // Local diagnostic channel (passive observer): reuse the request's correlationId.
  const diag = getDiagLogger().begin({ correlationId });
  // The org this request runs against — mirrors the remote telemetry `orgId`. Computed once (guarded,
  // never throws) and reused across telemetry and the diagnostic events below.
  const orgId = safeOrgId(conn);
  // Client-generated CLI-side trace id for this request (§2.4): emitted in telemetry and, once
  // SEND_CORRELATION_HEADER is enabled, also sent as a request header so the backend logs join to it.
  // Omit dataSpaceName entirely when absent (never send `dataSpaceName=undefined`).
  const params: Record<string, string> = { componentType };
  if (dataSpaceName?.trim()) {
    params.dataSpaceName = dataSpaceName;
  }
  const qs = new URLSearchParams(params).toString();
  try {
    // Offline-mock short-circuit (SF_DATACLOUD_MOCK): return the fixture before touching the org.
    if (mockEnabled()) return getMockComponents(componentType, dataSpaceName ?? '');
    diag.debug(Subsystem.API, 'API_REQ_START', 'requesting components', {
      operation: 'components',
      component_type: safeComponentType(componentType), // bounded TYPE only; never the dataspace/qs.
    });
    const resp = await conn.request<ComponentsResponse>(
      getRequest(`${basePath(conn)}/component/catalog?${qs}`, correlationId)
    );
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'components',
      componentType: safeComponentType(componentType), // bounded TYPE only; never the dataspace/qs.
      ...(orgId && { orgId }),
      success: true,
      resultCount: resp.components.length,
      durationMs: Date.now() - startedAt,
    });
    diag.debug(Subsystem.API, 'API_REQ_END', 'components received', {
      operation: 'components',
      component_type: safeComponentType(componentType),
      result_count: resp.components.length,
      duration_ms: Date.now() - startedAt,
      ...(orgId && { org_id: orgId }),
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, `list components of type "${componentType}"`);
    const errorMessage = errorMessageFrom(mapped);
    const gackId = extractGackId(errorMessage);
    void emitTelemetry('DATACLOUD_DEVOPS_API_REQUEST', {
      correlationId,
      operation: 'components',
      componentType: safeComponentType(componentType),
      ...(orgId && { orgId }),
      success: false,
      resultCount: 0,
      durationMs: Date.now() - startedAt,
      errorCode: mapped.code,
      ...(errorMessage && { errorMessage }),
      ...(gackId && { gackId }),
    });
    diag.error(Subsystem.API, 'API_REQ_ERR', 'components request failed', {
      operation: 'components',
      component_type: safeComponentType(componentType),
      error_code: mapped.code,
      ...(errorMessage && { error_message: errorMessage }),
      ...(orgId && { org_id: orgId }),
      duration_ms: Date.now() - startedAt,
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
  dataSpaceName?: string,
  correlationId: string = randomUUID()
): Promise<RetrieveApiResponse> {
  // Local diagnostic channel (passive observer): reuse the request's correlationId.
  const diag = getDiagLogger().begin({ correlationId });
  // The org this request runs against — mirrors the remote telemetry `orgId`. Computed once (guarded,
  // never throws) and attached to the local diagnostic events below.
  const orgId = safeOrgId(conn);
  const startedAt = Date.now();
  // Omit dataSpaceName entirely when absent (never send `dataSpaceName=undefined`).
  const params: Record<string, string> = { componentType, componentName };
  if (dataSpaceName?.trim()) {
    params.dataSpaceName = dataSpaceName;
  }
  const qs = new URLSearchParams(params).toString();
  try {
    // Offline-mock short-circuit (SF_DATACLOUD_MOCK): return the fixture before touching the org.
    if (mockEnabled()) return getMockRetrieveApiResponse(dataSpaceName ?? '');
    diag.debug(Subsystem.API, 'API_REQ_START', 'requesting snapshot', {
      operation: 'snapshot',
      component_type: safeComponentType(componentType),
    });
    // correlationId is the retrieve-service's id (passed in) so the future header matches its telemetry.
    const resp = await conn.request<RetrieveApiResponse>(
      getRequest(`${basePath(conn)}/component/snapshot?${qs}`, correlationId)
    );
    diag.debug(Subsystem.API, 'API_REQ_END', 'snapshot received', {
      operation: 'snapshot',
      component_type: safeComponentType(componentType),
      result_count: resp.components.length,
      duration_ms: Date.now() - startedAt,
      ...(orgId && { org_id: orgId }),
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, `retrieve snapshot for ${componentType}:${componentName}`);
    const errorMessage = errorMessageFrom(mapped);
    diag.error(Subsystem.API, 'API_REQ_ERR', 'snapshot request failed', {
      operation: 'snapshot',
      component_type: safeComponentType(componentType),
      error_code: mapped.code,
      ...(errorMessage && { error_message: errorMessage }),
      ...(orgId && { org_id: orgId }),
      duration_ms: Date.now() - startedAt,
    });
    throw mapped;
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
export async function createPromotion(
  conn: Connection,
  request: DeployApiRequest,
  correlationId: string = randomUUID()
): Promise<DeployApiResponse> {
  // Local diagnostic channel (passive observer): reuse the request's correlationId.
  const diag = getDiagLogger().begin({ correlationId });
  // The org this request runs against — mirrors the remote telemetry `orgId`. Computed once (guarded,
  // never throws) and attached to the local diagnostic events below.
  const orgId = safeOrgId(conn);
  const startedAt = Date.now();
  try {
    diag.debug(Subsystem.API, 'API_REQ_START', 'submitting promotion', {
      operation: 'promotion',
      component_count: request.length,
    });
    const resp = await conn.request<DeployApiResponse>({
      method: 'POST',
      url: `${basePath(conn)}/component/promotion`,
      body: JSON.stringify({ components: request }),
      // correlationId (deploy-service's id) joins to its telemetry once the header is enabled.
      headers: { 'Content-Type': 'application/json', ...correlationHeaders(correlationId) },
    });
    diag.debug(Subsystem.API, 'API_REQ_END', 'promotion submitted', {
      operation: 'promotion',
      duration_ms: Date.now() - startedAt,
      ...(orgId && { org_id: orgId }),
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, 'deploy components');
    const errorMessage = errorMessageFrom(mapped);
    diag.error(Subsystem.API, 'API_REQ_ERR', 'promotion request failed', {
      operation: 'promotion',
      error_code: mapped.code,
      ...(errorMessage && { error_message: errorMessage }),
      ...(orgId && { org_id: orgId }),
      duration_ms: Date.now() - startedAt,
    });
    throw mapped;
  }
}

/**
 * GET /ssot/devops/component/promotion/{jobId} — poll an async promotion (deploy) job's status (§5.7).
 * Returns the overall job status plus a per-component status array. Like getSnapshot, this maps errors
 * via toSfError but emits no telemetry — the DEPLOY_STATUS_POLL event (with its correlationId) is
 * emitted by deploy-status-service. The jobId is URL-encoded as a defensive measure (it is a path
 * segment); valid 15/18-char Salesforce IDs pass through unchanged.
 */
export async function getPromotionStatus(
  conn: Connection,
  jobId: string,
  correlationId: string = randomUUID()
): Promise<DeployStatusApiResponse> {
  // Local diagnostic channel (passive observer): reuse the request's correlationId.
  const diag = getDiagLogger().begin({ correlationId });
  // The org this request runs against — mirrors the remote telemetry `orgId`. Computed once (guarded,
  // never throws) and attached to the local diagnostic events below.
  const orgId = safeOrgId(conn);
  const startedAt = Date.now();
  try {
    diag.debug(Subsystem.API, 'API_REQ_START', 'requesting promotion status', { operation: 'promotionStatus' });
    // correlationId is deploy-status-service's id so the future header matches its poll telemetry.
    const resp = await conn.request<DeployStatusApiResponse>(
      getRequest(`${basePath(conn)}/component/promotion/${encodeURIComponent(jobId)}`, correlationId)
    );
    diag.debug(Subsystem.API, 'API_REQ_END', 'promotion status received', {
      operation: 'promotionStatus',
      result_count: resp.components.length,
      duration_ms: Date.now() - startedAt,
      ...(orgId && { org_id: orgId }),
    });
    return resp;
  } catch (err) {
    const mapped = toSfError(err, `check deploy status for job "${jobId}"`);
    const errorMessage = errorMessageFrom(mapped);
    diag.error(Subsystem.API, 'API_REQ_ERR', 'promotion status request failed', {
      operation: 'promotionStatus',
      error_code: mapped.code,
      ...(errorMessage && { error_message: errorMessage }),
      ...(orgId && { org_id: orgId }),
      duration_ms: Date.now() - startedAt,
    });
    throw mapped;
  }
}
