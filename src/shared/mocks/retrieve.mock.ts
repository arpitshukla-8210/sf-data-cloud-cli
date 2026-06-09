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
 * DUMMY DATA — Week 1 only. Simulates the standardized output of POST /ssot/devops/retrieve
 * (PROJECT_KNOWLEDGE.md §1.3, §5.5): a Calculated Insight, a Data Transform, and the
 * DataModelObjects / DataLakeObjects the backend auto-spiders, each with its server-resolved
 * dependsOn edges. This stands in for the service layer's result, so the raw per-component
 * payload (entitypayload / data) is already stripped — it never appears here. No network call
 * or file write happens.
 *
 * TODO(Week 2–3): delete this module; replace the call site in the command with a real
 * Connect API client (shared/services/devops-api.ts) returning RetrieveResult, and persist
 * each component to disk in the §5.2 layout.
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
