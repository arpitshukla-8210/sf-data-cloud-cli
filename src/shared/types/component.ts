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
 * Type definitions for the Data Cloud DevOps "list components by type" contract.
 * Mirrors GET /ssot/devops/component/catalog (PROJECT_KNOWLEDGE.md §5.4).
 * The mock (today) and the real Connect API client (Week 2–3) both satisfy these
 * types, so the command never changes when we swap the data source.
 */

/** One component row, exactly as the component-list endpoint returns it (§5.4). */
export type ComponentSummary = {
  /** API/developer name of the component, e.g. "HighValueCustomers". */
  componentName: string;
};

/** Raw Connect API response shape for the component-list endpoint (§5.4). */
export type ComponentsResponse = {
  components: ComponentSummary[];
};

/** Shape returned by `sf data-cloud component list --json`. */
export type ComponentListResult = {
  components: ComponentSummary[];
};
