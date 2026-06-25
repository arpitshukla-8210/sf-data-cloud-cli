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
import { DeploymentLifecycleStatus } from '../types/deploy.js';
import { ComponentStatus, DeployStatusComponent, DeployStatusResult } from '../types/deploy-status.js';
import { getPromotionStatus } from './devops-api.js';
import { emitTelemetry } from './telemetry.js';

/*
 * Orchestrator for `sf data-cloud deploy status` (PROJECT_KNOWLEDGE.md §2.4, §5.7). Mirrors
 * deploy-service: own the correlationId/startedAt, GET the promotion job's status via the
 * devops-api HTTP boundary, normalize the backend's PascalCase enums to the CLI's UPPERCASE
 * vocabulary, emit one DEPLOY_STATUS_POLL telemetry event on success AND failure, and re-throw the
 * original error. The PascalCase->UPPERCASE mapping lives here (the service seam), so the command
 * and the HTTP boundary both stay agnostic of the wire casing.
 */

/**
 * Normalizes the overall job status (CdpDevOpsPromotionStatusEnum, PascalCase) to the CLI's
 * UPPERCASE DeploymentLifecycleStatus. An unknown/unexpected value folds to INPROGRESS (treated as
 * non-terminal) so a poll never reports a false terminal state. Exported for unit testing.
 */
export function toLifecycleStatus(raw: string): DeploymentLifecycleStatus {
  switch (raw) {
    case 'Success':
      return 'SUCCESS';
    case 'Failed':
      return 'FAILED';
    case 'Created':
      return 'CREATED';
    case 'InProgress':
    default:
      return 'INPROGRESS';
  }
}

/**
 * Normalizes a per-component status (CdpDevOpsComponentStatusEnum, PascalCase) to ComponentStatus.
 * The enum also defines `Pending`, which the backend rollup never emits (STARTED/null -> InProgress);
 * it and any unknown value fold to INPROGRESS. Exported for unit testing.
 */
export function toComponentStatus(raw: string): ComponentStatus {
  switch (raw) {
    case 'Success':
      return 'SUCCESS';
    case 'Failed':
      return 'FAILED';
    case 'InProgress':
    case 'Pending':
    default:
      return 'INPROGRESS';
  }
}

/**
 * Derives a machine-parseable classification code for a terminal FAILED job (§5.7) — for agent/CI
 * consumers. A failed component means validation/deploy of a specific element broke
 * (`ComponentValidationError`); a FAILED job with no failed component is a job-level failure
 * (`DeployJobFailed`). Reads only the safe per-component status, never names or error messages.
 * Exported for unit testing.
 */
export function deriveDeployErrorCode(components: DeployStatusComponent[]): string {
  return components.some((c) => c.status === 'FAILED') ? 'ComponentValidationError' : 'DeployJobFailed';
}

/**
 * Polls a deploy job's status (§6.1): GET the promotion status, normalize the PascalCase wire enums
 * to UPPERCASE, and return DeployStatusResult. Emits one telemetry event (success and failure) and
 * re-throws the original error so propagation is unchanged.
 *
 * @param conn - the authenticated org connection (resolved from --target-org by the command).
 * @param jobId - the tracking job ID returned by the deploy submission.
 */
export async function checkDeployStatus(conn: Connection, jobId: string): Promise<DeployStatusResult> {
  // Telemetry (§2.4): one event per call, success and failure. `void` keeps it off the latency path
  // and the helper never throws, so neither the return value nor error propagation is affected.
  const startedAt = Date.now();
  // Client-generated CLI-side trace id for this poll (§2.4). Emitted in telemetry now that the status
  // backend is live; sending it as a request header is deferred until that contract exists.
  const correlationId = randomUUID();
  try {
    const api = await getPromotionStatus(conn, jobId);

    const components: DeployStatusComponent[] = api.components.map((c) => ({
      componentName: c.componentName,
      componentType: c.componentType,
      status: toComponentStatus(c.status),
      // `error` is present only on a failed component — carry it only when the backend sent one.
      ...(c.error != null && { error: c.error }),
    }));

    const result: DeployStatusResult = {
      jobId: api.jobId,
      status: toLifecycleStatus(api.status),
      components,
    };

    const isTerminal = result.status === 'SUCCESS' || result.status === 'FAILED';
    void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL', {
      correlationId,
      lifecycleStatus: result.status,
      isTerminal,
      success: result.status === 'SUCCESS',
      componentCount: components.length,
      hadComponentError: components.some((c) => c.status === 'FAILED'),
      durationMs: Date.now() - startedAt,
      // Machine-parseable classification for agent/CI consumers; present only on a terminal FAILED.
      ...(result.status === 'FAILED' && { errorCode: deriveDeployErrorCode(components) }),
    });

    return result;
  } catch (err) {
    void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL', {
      correlationId,
      success: false,
      durationMs: Date.now() - startedAt,
      errorCode: err instanceof SfError ? err.code : 'UnexpectedError',
    });
    throw err; // re-throw the ORIGINAL error object — propagation unchanged.
  }
}
