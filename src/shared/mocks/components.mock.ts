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

import { ComponentsResponse, ComponentSummary } from '../types/component.js';

/*
 * DUMMY DATA — Week 1 only. Simulates GET /ssot/devops/component/catalog
 * (PROJECT_KNOWLEDGE.md §5.4), which filters server-side by componentType + dataSpaceName.
 * The real endpoint never returns the type/dataspace on each row, so we keep those keys on a
 * private fixture type and strip them before returning the §5.4 response shape ({ components }).
 * No network call is made.
 *
 * TODO(Week 2–3): delete this module; replace the call site in the command with a
 * real Connect API client (shared/services/devops-api.ts) returning ComponentsResponse.
 */

/** Fixture row: a §5.4 component plus the fields the server filters on (never returned to the client). */
type MockComponentRow = ComponentSummary & {
  componentType: string;
  dataspace: string;
};

const allMocks: MockComponentRow[] = [
  {
    componentName: 'HighValueCustomers',
    componentType: 'CalculatedInsight',
    dataspace: 'default',
  },
  {
    componentName: 'ChurnRiskScore',
    componentType: 'CalculatedInsight',
    dataspace: 'default',
  },
  {
    componentName: 'LTVForecast',
    componentType: 'CalculatedInsight',
    dataspace: 'default',
  },
  {
    componentName: 'B2C_Commerce_Connection',
    componentType: 'DataConnection',
    dataspace: 'default',
  },
  {
    componentName: 'Custom_Transform_Engine',
    componentType: 'DataTransform',
    dataspace: 'analytics_ds',
  },
];

/**
 * Returns the dummy component-list response filtered by component type and dataspace,
 * mirroring how the real endpoint scopes results via its query parameters (§5.4).
 * Matching is case-insensitive on both axes. The internal type/dataspace fields are
 * stripped so the result matches the documented on-the-wire shape exactly.
 */
export function getMockComponents(componentType: string, dataspace: string): ComponentsResponse {
  const components: ComponentSummary[] = allMocks
    .filter(
      (c) =>
        c.componentType.toLowerCase() === componentType.toLowerCase() &&
        c.dataspace.toLowerCase() === dataspace.toLowerCase()
    )
    .map(({ componentName }) => ({ componentName }));

  return { components };
}
