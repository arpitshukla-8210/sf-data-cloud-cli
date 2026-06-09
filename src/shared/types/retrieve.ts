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
 * Type definitions for the Data Cloud DevOps "retrieve" contract.
 * Mirrors POST /ssot/devops/retrieve (PROJECT_KNOWLEDGE.md §1.7, §5.5), which returns the
 * named component plus its server-resolved dependency graph.
 * These are the standardized types the service layer produces: the raw per-component payload
 * (entitypayload / data) the API returns is stripped to disk and never surfaces here.
 * The mock (today) and the real Connect API client (Week 2–3) both satisfy these types,
 * so the command never changes when we swap the data source.
 */

/** A single dependency edge (type + API name) within a component's dependency graph. */
export type ComponentDependency = {
  /** API/developer name of the depended-on component, e.g. "Divvy_TripsDmo". */
  componentName: string;
  /** API value of the depended-on component's type, e.g. "DataModelObject". */
  componentType: string;
};

/** One component in the resolved dependency graph (standardized: no raw payload). */
export type RetrievedComponentInfo = {
  /** API value of the component type, e.g. "CalculatedInsight". */
  componentType: string;
  /** API/developer name of the component, e.g. "highValueCustomer". */
  componentName: string;
  /** Developer name of the dataspace this component belongs to. */
  dataspaceName: string;
  /** Direct dependencies (server-resolved); empty array for leaf components. */
  dependsOn: ComponentDependency[];
};

/** Shape returned by `sf data-cloud retrieve` (and what `--json` emits). */
export type RetrieveResult = {
  /** Developer name of the dataspace the retrieve was scoped to. */
  dataspace: string;
  /** The user-requested component, in TYPE:NAME form, e.g. "CalculatedInsight:highValueCustomer". */
  targetComponent: string;
  /** The requested component plus its server-resolved dependency graph. */
  retrievedComponents: RetrievedComponentInfo[];
  /** Dataspace-aware directory the components would be written to (§5.2). */
  fileWriteLocation: string;
};
