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
 * Mirrors POST /ssot/devops/deploy (PROJECT_KNOWLEDGE.md §1.7, §1.10, §5.6), which kicks off an
 * async background deploy and synchronously returns a tracking jobId in the CREATED state.
 * The mock (today) and the real Connect API client (Week 2–3) both satisfy these types,
 * so the command never changes when we swap the data source.
 */

import { ComponentDependency } from './retrieve.js';

/**
 * Deploy job lifecycle states (§5.6): the synchronous response is always CREATED; the job then
 * advances to INPROGRESS and finally SUCCESS or FAILED, polled via `sf data-cloud deploy status`.
 */
export type DeploymentLifecycleStatus = 'CREATED' | 'INPROGRESS' | 'SUCCESS' | 'FAILED';

/** Shape returned by `sf data-cloud deploy` (and what `--json` emits). */
export type DeployResult = {
  /** Tracking identifier for the async deploy job; passed to `deploy status` to poll progress. */
  jobId: string;
  /** Initial job state from the synchronous deploy response — always 'CREATED' per contract (§5.6). */
  status: DeploymentLifecycleStatus;
};

// ─── Deploy API request types (§5.6, §6.1) ─────────────────────────────────

/**
 * One component in the deploy API request payload. Differs from the on-disk ComponentFile in two
 * ways: the payload key is `data` (not `entityPayload`), and there is no `dataspaceName` (it lives
 * at the request top level only).
 */
export type DeployRequestComponent = {
  /** API/developer name of the component. */
  componentName: string;
  /** API value of the component type. */
  componentType: string;
  /** Direct dependencies, copied from the on-disk file's dependsOn. */
  dependsOn: ComponentDependency[];
  /**
   * The component payload — verbatim from the on-disk `entityPayload`, never re-parsed (§5.6,
   * Challenges). An object (CI, DMO) or a string (DataTransform, DLO); passed byte-for-byte.
   */
  data: unknown;
};

/**
 * Full POST /ssot/devops/deploy request body (§5.6). The CLI assembles this from local files after
 * walking transitive dependencies; the server validates and computes the topological deploy order.
 */
export type DeployApiRequest = {
  /** Developer name of the dataspace context (top level, not per-component). */
  dataSpaceName: string;
  /** The named component plus all its transitive dependencies. */
  components: DeployRequestComponent[];
};
