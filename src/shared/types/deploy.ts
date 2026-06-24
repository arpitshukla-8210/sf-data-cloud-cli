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
 * Type definitions for the Data Cloud DevOps "deploy" contract.
 * Mirrors POST /ssot/devops/component/promotion (PROJECT_KNOWLEDGE.md §1.7, §1.10, §5.6), which kicks off an
 * async background deploy. The backend-confirmed contract: the request body is a bare ARRAY of
 * components (each is the exact on-disk snapshot JSON, payload under `entityPayload`); the
 * synchronous response carries `{ status: 'SUBMITTED', jobId }` (the jobId is always returned, even
 * as a placeholder until status polling lands). The mock (offline testing) and the real Connect API
 * client both satisfy these types, so the command never changes when we swap the data source.
 */

import { ComponentDependency } from './retrieve.js';

/**
 * Deploy job lifecycle states. The live synchronous response is 'SUBMITTED'; the job then advances
 * to INPROGRESS and finally SUCCESS or FAILED, intended to be polled via `sf data-cloud deploy
 * status` once that endpoint exists. 'CREATED' is retained for the offline mock and the documented
 * §5.6 example.
 */
export type DeploymentLifecycleStatus = 'SUBMITTED' | 'CREATED' | 'INPROGRESS' | 'SUCCESS' | 'FAILED';

/**
 * Raw synchronous body of POST /ssot/devops/component/promotion: a submission `status` ('SUBMITTED' on the live
 * path) plus the tracking `jobId` the backend always returns (a placeholder until status polling is
 * implemented server-side). `status` is kept as a plain string at the HTTP boundary so an unexpected
 * backend value never fails type-narrowing; it is narrowed to DeploymentLifecycleStatus when mapped
 * into DeployResult.
 */
export type DeployApiResponse = {
  status: string;
  jobId: string;
};

/** Shape returned by `sf data-cloud deploy` (and what `--json` emits). */
export type DeployResult = {
  /** Tracking identifier for the async deploy job; passed to `deploy status` to poll progress. */
  jobId: string;
  /** Job state from the synchronous deploy response — 'SUBMITTED' on the live path (§5.6). */
  status: DeploymentLifecycleStatus;
};

// ─── Deploy API request types (§5.6, §6.1) ─────────────────────────────────

/**
 * One component in the deploy API request payload. This is the on-disk ComponentFile passed through
 * verbatim — the payload key is `entityPayload` (NOT `data`) and `dataspaceName` is carried
 * per-component (there is no top-level dataspace wrapper). Matches the backend's
 * CdpDevOpsComponentPayloadInputRepresentation (getEntityPayload / getDataspaceName).
 */
export type DeployRequestComponent = {
  /** API value of the component type. */
  componentType: string;
  /** API/developer name of the component. */
  componentName: string;
  /** Developer name of the dataspace this component belongs to (empty string for root-level types). */
  dataspaceName: string;
  /** Direct dependencies, copied from the on-disk file's dependsOn. */
  dependsOn: ComponentDependency[];
  /**
   * The component payload — verbatim from the on-disk `entityPayload`, never re-parsed (§5.6,
   * Challenges). An object (CI, DMO) or a string (DataTransform, DLO); passed byte-for-byte.
   */
  entityPayload: unknown;
};

/**
 * Full POST /ssot/devops/component/promotion request body (§5.6): a bare ARRAY of components — the named component
 * plus all its transitive dependencies. The CLI assembles this from local files after walking
 * dependsOn; the server validates and computes the topological deploy order. There is no wrapper
 * object and no top-level dataSpaceName — dataspace is per-component.
 */
export type DeployApiRequest = DeployRequestComponent[];
