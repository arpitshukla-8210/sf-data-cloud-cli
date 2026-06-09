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

import { DeployResult } from '../types/deploy.js';

/*
 * DUMMY DATA — Week 1 only. Simulates the synchronous response from POST /ssot/devops/deploy
 * (PROJECT_KNOWLEDGE.md §1.10, §5.6): the deploy is enqueued as a background job and the call
 * returns immediately with a tracking jobId in the CREATED state. The jobId mirrors the §5.6
 * example. No network call or org contact happens.
 *
 * The real response shape does not vary by which component or dataspace is deployed (only jobId
 * + status come back), so this mock takes no arguments. The actual deploy inputs are validated
 * upstream as required flags on the command.
 *
 * TODO(Week 2–3): delete this module; replace the call site in the command with a real Connect
 * API client (shared/services/devops-api.ts) that POSTs the assembled component payload and
 * returns DeployResult.
 */

/** Returns the dummy deploy result: a tracking jobId in the initial CREATED state (§5.6). */
export function getMockDeployResult(): DeployResult {
  return {
    jobId: '08PVF000002iQIb',
    status: 'CREATED',
  };
}
