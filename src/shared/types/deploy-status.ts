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

/*
 * Type definitions for the Data Cloud DevOps "deploy status" contract.
 * Mirrors GET /ssot/devops/component/promotion/{jobId} (PROJECT_KNOWLEDGE.md §1.7, §5.7), which the
 * client polls until the async deploy job reaches a terminal state. The backend returns the overall
 * job status plus a per-component status array; the service normalizes the backend's PascalCase enum
 * values to the CLI's UPPERCASE lifecycle vocabulary, so the command renders a single, consistent
 * representation regardless of the wire casing.
 */

import { DeploymentLifecycleStatus } from './deploy.js';

/**
 * Per-component status, CLI-normalized to UPPERCASE. The backend's CdpDevOpsComponentStatusEnum is
 * Success | Failed | InProgress (the enum also defines Pending, but the backend rollup never emits
 * it — STARTED/null roll up to InProgress); the service folds Pending and any unknown into INPROGRESS.
 */
export type ComponentStatus = 'SUCCESS' | 'FAILED' | 'INPROGRESS';

// ─── HTTP boundary (raw wire shape) ─────────────────────────────────────────

/**
 * One component entry in the raw GET /ssot/devops/component/promotion/{jobId} response. `status` is
 * kept as a plain string at the HTTP boundary so an unexpected backend value never fails
 * type-narrowing (same discipline as DeployApiResponse); it is normalized to ComponentStatus when
 * mapped into DeployStatusComponent. `error` is present only on a failed component.
 */
export type DeployStatusApiComponent = {
  componentName: string;
  componentType: string;
  status: string;
  error?: string;
};

/** Raw body of GET /ssot/devops/component/promotion/{jobId}: overall job status + per-component array. */
export type DeployStatusApiResponse = {
  jobId: string;
  status: string;
  components: DeployStatusApiComponent[];
};

// ─── CLI-facing (normalized) ────────────────────────────────────────────────

/**
 * A component's status in the normalized result (§5.7). Structured + actionable (type + status +
 * optional reason) per the AI-era error principle — never a raw gack or "contact support".
 */
export type DeployStatusComponent = {
  componentName: string;
  componentType: string;
  status: ComponentStatus;
  /** Populated only when this component FAILED, to isolate the breaking element. */
  error?: string;
};

/** Shape returned by `sf data-cloud deploy status` (and what `--json` emits). */
export type DeployStatusResult = {
  jobId: string;
  status: DeploymentLifecycleStatus;
  /** Per-component status; empty when the job is CREATED (queued, no component rows written yet). */
  components: DeployStatusComponent[];
};
