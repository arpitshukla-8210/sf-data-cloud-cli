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

import { DeployStatusResult } from '../types/deploy-status.js';

/*
 * DUMMY DATA — Week 1 only. Simulates the status response payload returned by
 * GET /ssot/devops/deploy/{jobId}/status (PROJECT_KNOWLEDGE.md §5.7). No network call or org contact
 * happens. If the jobId contains 'fail', it triggers a mock FAILED state with a structured,
 * component-level error (the AI-era requirement that errors carry code + message + failing
 * component, never a raw gack); otherwise it returns a terminal SUCCESS.
 *
 * TODO(Week 2–3): delete this module; replace the call site in the command with a real Connect
 * API client (shared/services/devops-api.ts) that GETs deploy/{jobId}/status and returns
 * DeployStatusResult.
 */
export function getMockDeployStatus(jobId: string): DeployStatusResult {
  if (jobId.toLowerCase().includes('fail')) {
    return {
      jobId,
      status: 'FAILED',
      components: {
        componentName: 'HighValueCustomers',
        error:
          'Component validation failed: Calculated Insight expression contains an invalid syntax at line 4, column 12.',
      },
    };
  }

  return {
    jobId,
    status: 'SUCCESS',
  };
}
