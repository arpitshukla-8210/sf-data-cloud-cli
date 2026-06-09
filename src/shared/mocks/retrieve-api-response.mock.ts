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

import { RetrieveApiResponse } from '../types/retrieve.js';

/*
 * DUMMY DATA — Week 1 only. Simulates the RAW POST /ssot/devops/retrieve response
 * (PROJECT_KNOWLEDGE.md §5.5): the requested Calculated Insight plus its server-spidered Data
 * Transform, DataModelObjects, and DataLakeObject — each WITH its type-specific payload still
 * attached. This is the input the file-writer persists to disk before the service strips payloads
 * to the standardized RetrieveResult. Same 5 components, order, and dependsOn edges as
 * retrieve.mock.ts, but each one carries a payload under the inconsistent key the API really uses:
 *   - CI + the Divvy DMO use `entitypayload` (lowercase object),
 *   - the Transform + DLO use `data: { entityPayload: "<serialized string>" }` (nested camelCase),
 *   - the Account DMO uses a plain `data` object (no nested entityPayload).
 * This deliberately exercises every branch of normalizeEntityPayload. No network call is made.
 *
 * TODO(Week 2–3): replace the call site in shared/services/retrieve-service.ts with a real Connect
 * API client returning RetrieveApiResponse; this fixture can then be retired.
 */

/**
 * Returns the dummy raw retrieve response for a dataspace. Every component's `dataspaceName` is set
 * to the requested dataspace so the file-writer routes dataspace-scoped components under it.
 */
export function getMockRetrieveApiResponse(dataspace: string): RetrieveApiResponse {
  return {
    components: [
      {
        componentType: 'CalculatedInsight',
        componentName: 'highValueCustomer',
        dataspaceName: dataspace,
        dependsOn: [{ componentName: 'Divvy_TripsDmo', componentType: 'DataModelObject' }],
        entitypayload: {
          masterLabel: 'testCI',
          expression:
            'SELECT COUNT(Divvy_TripsDmo__dlm.DataSource__c) AS cnt__c, Divvy_TripsDmo__dlm.from_station_name__c AS grp__c FROM Divvy_TripsDmo__dlm GROUP BY grp__c',
          builderExpression: {
            app: { insightType: 'CALCULATED_METRIC', targetCurrencyType: '' },
            dataNodes: {},
            ui: {},
            relatedDMOs: [],
          },
          definitionType: 'CALCULATED_METRIC',
          creationType: 'Custom',
          scheduleInterval: '0',
          sourceObjectDevName: 'testCI',
        },
      },
      {
        componentType: 'DataModelObject',
        componentName: 'Divvy_TripsDmo',
        dataspaceName: dataspace,
        dependsOn: [],
        entitypayload: {
          masterLabel: 'Divvy Trips',
          objectApiName: 'Divvy_TripsDmo__dlm',
          fields: [
            { name: 'DataSource__c', dataType: 'text' },
            { name: 'from_station_name__c', dataType: 'text' },
            { name: 'trip_id__c', dataType: 'text' },
          ],
        },
      },
      {
        componentType: 'DataTransform',
        componentName: 'myTransform',
        dataspaceName: dataspace,
        dependsOn: [
          { componentName: 'myDLO', componentType: 'DataLakeObject' },
          { componentName: 'AccountDmo', componentType: 'DataModelObject' },
        ],
        data: {
          entityPayload: '{ "label": "My Transform", "type": "BATCH", "name": "myTransform", "version": "1" }',
        },
      },
      {
        componentType: 'DataLakeObject',
        componentName: 'myDLO',
        dataspaceName: dataspace,
        dependsOn: [{ componentName: 'AccountDmo', componentType: 'DataModelObject' }],
        data: {
          entityPayload:
            '{ "type": "DLO", "developerName": "myDLO", "schema": { "externalObjectName": "my_dlo", "fields": [] } }',
        },
      },
      {
        componentType: 'DataModelObject',
        componentName: 'AccountDmo',
        dataspaceName: dataspace,
        dependsOn: [],
        data: {
          masterLabel: 'Account',
          objectApiName: 'AccountDmo__dlm',
          fields: [
            { name: 'Id__c', dataType: 'text' },
            { name: 'Name__c', dataType: 'text' },
            { name: 'Industry__c', dataType: 'text' },
          ],
        },
      },
    ],
  };
}
