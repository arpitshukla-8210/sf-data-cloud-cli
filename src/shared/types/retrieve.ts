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
 * Mirrors GET /ssot/devops/component/snapshot (PROJECT_KNOWLEDGE.md §1.7, §5.5), which returns the
 * named component plus its server-resolved dependency graph.
 * These are the standardized types the service layer produces: the raw per-component payload
 * (entityPayload) the API returns is stripped to disk and never surfaces here.
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
  /**
   * Write root for this retrieve (§5.2), e.g. "./data-cloud/default/". DataLakeObject definitions
   * are written outside this dir (./data-cloud/data-lake-objects/); see "./data-cloud/manifest.json"
   * for the authoritative inventory of all files written.
   */
  fileWriteLocation: string;
};

/**
 * One component as the raw GET /ssot/devops/component/snapshot API returns it (§5.5): the
 * standardized fields PLUS a raw, type-specific payload under a single `entityPayload` key (always a
 * JSON object). The file-writer carries that payload through to disk verbatim. These raw types are
 * the INPUT to the service layer and never reach the command's `RetrieveResult` — the payload is
 * stripped before the standardized result is returned.
 */
export type RawRetrievedComponent = {
  /** API value of the component type, e.g. "CalculatedInsight". */
  componentType: string;
  /** API/developer name of the component, e.g. "highValueCustomer". */
  componentName: string;
  /** Developer name of the dataspace this component belongs to. */
  dataspaceName: string;
  /** Direct dependencies (server-resolved); empty array for leaf components. */
  dependsOn: ComponentDependency[];
  /** Full component definition JSON — always an object (`Map<String,Object>` on the wire). */
  entityPayload: Record<string, unknown>;
};

/** Raw GET /ssot/devops/component/snapshot response (pre-strip, payloads still attached). */
export type RetrieveApiResponse = {
  /** The requested component plus its server-spidered dependencies, in deployment order. */
  components: RawRetrievedComponent[];
};
