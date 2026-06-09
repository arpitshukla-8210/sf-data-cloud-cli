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
 * Mirrors GET /ssot/devops/deploy/{jobId}/status (PROJECT_KNOWLEDGE.md §1.7, §5.7), which the client
 * polls until the async deploy job reaches a terminal state. The mock (today) and the real Connect
 * API client (Week 2–3) both satisfy these types, so the command never changes when we swap sources.
 */

import { DeploymentLifecycleStatus } from './deploy.js';

/**
 * The single failing component isolated on a FAILED job (§5.7). Structured + actionable
 * (component + reason) per the AI-era error principle — never a raw gack or "contact support".
 */
export type FailedComponentDetail = {
  componentName: string;
  error: string;
};

/** Structural representation matching the GET /ssot/devops/deploy/{jobId}/status contract. */
export type DeployStatusResult = {
  jobId: string;
  status: DeploymentLifecycleStatus;
  /** Populated only when top-level status is FAILED to isolate the breaking element. */
  components?: FailedComponentDetail;
};
