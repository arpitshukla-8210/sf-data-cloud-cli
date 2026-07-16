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

import { RetrieveResult } from '../types/retrieve.js';

/*
 * SUPERSEDED — kept for reference only. As of Phase 2 the command sources its data from
 * shared/services/retrieve-service.ts, which consumes the RAW response fixture
 * (shared/mocks/retrieve-api-response.mock.ts) and writes files to disk before stripping payloads.
 * This module is no longer imported anywhere; it is retained as a concise reference for the
 * STANDARDIZED RetrieveResult shape (PROJECT_KNOWLEDGE.md §5.5) — the raw per-component payload
 * (entityPayload) is already stripped here, so it shows exactly what the command returns.
 *
 * DUMMY DATA — Week 1 only: a Calculated Insight, a Data Transform, and the DataModelObjects /
 * DataLakeObjects the backend auto-spiders, each with its server-resolved dependsOn edges. No
 * network call or file write happens.
 */

/**
 * Returns the dummy retrieve result for a requested component within a dataspace.
 * The component is echoed back as the targetComponent (TYPE:NAME), and the dataspace
 * drives both each component's dataspaceName and the deterministic, dataspace-aware
 * write location (§5.2).
 */
export function getMockRetrieveResult(component: string, dataspace: string): RetrieveResult {
  return {
    dataspace,
    targetComponent: component,
    fileWriteLocation: `./data-cloud/${dataspace}/`,
    retrievedComponents: [
      {
        componentType: 'CalculatedInsight',
        componentName: 'highValueCustomer',
        dataspaceName: dataspace,
        dependsOn: [{ componentName: 'Divvy_TripsDmo', componentType: 'DataModelObject' }],
      },
      {
        componentType: 'DataModelObject',
        componentName: 'Divvy_TripsDmo',
        dataspaceName: dataspace,
        dependsOn: [],
      },
      {
        componentType: 'DataTransform',
        componentName: 'myTransform',
        dataspaceName: dataspace,
        dependsOn: [
          { componentName: 'myDLO', componentType: 'DataLakeObject' },
          { componentName: 'AccountDmo', componentType: 'DataModelObject' },
        ],
      },
      {
        componentType: 'DataLakeObject',
        componentName: 'myDLO',
        dataspaceName: dataspace,
        dependsOn: [{ componentName: 'AccountDmo', componentType: 'DataModelObject' }],
      },
      {
        componentType: 'DataModelObject',
        componentName: 'AccountDmo',
        dataspaceName: dataspace,
        dependsOn: [],
      },
    ],
  };
}
