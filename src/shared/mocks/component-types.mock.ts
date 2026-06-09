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

import { ComponentTypesResponse } from '../types/component-type.js';

/*
 * DUMMY DATA — Week 1 only. Static, schema-accurate response matching
 * GET /ssot/devops/component-types exactly as documented in PROJECT_KNOWLEDGE.md §5.3.
 * No network call is made.
 *
 * TODO(Week 2–3): delete this module; replace the call site in the command with a
 * real Connect API client (shared/services/devops-api.ts) returning ComponentTypesResponse.
 */
export function getMockComponentTypes(): ComponentTypesResponse {
  return {
    supportedComponentTypes: {
      DataConnection: 'Data Connection',
      DataStreamBundle: 'Data Stream',
      CalculatedInsight: 'Calculated Insight',
      DataLakeObject: 'Data Lake Object',
      DataTransform: 'Data Transform',
      IdentityResolution: 'Identity Resolution',
      DataGraph: 'Data Graph',
    },
  };
}
