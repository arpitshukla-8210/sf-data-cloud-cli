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
 * Type definitions for the Data Cloud DevOps "component types" contract.
 * Mirrors GET /ssot/devops/component-types (PROJECT_KNOWLEDGE.md §5.3).
 * The mock (today) and the real Connect API client (Week 2–3) both satisfy these
 * types, so the command never changes when we swap the data source.
 */

/** Raw Connect API response. Key = componentType value; value = display label. */
export type ComponentTypesResponse = {
  supportedComponentTypes: Record<string, string>;
};

/** Flattened, display-friendly row for CLI output. */
export type ComponentTypeSummary = {
  /** API value, e.g. "CalculatedInsight" — pass this to other commands. */
  componentType: string;
  /** Display label, e.g. "Calculated Insight". */
  label: string;
};

/** Shape returned by `sf data-cloud component-type list --json`. */
export type ComponentTypeListResult = {
  componentTypes: ComponentTypeSummary[];
};
