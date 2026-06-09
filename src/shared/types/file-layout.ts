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
 * On-disk file format contract for the local `data-cloud/` source tree (PROJECT_KNOWLEDGE.md §5.1,
 * §5.8). This is the durable, human-readable representation the file-writer produces on `retrieve`
 * and the deploy walker will read back on `deploy` — so it lives in its own module, shared by both
 * sides. Unlike the standardized `RetrieveResult` (which strips payloads), these types are where the
 * normalized `entityPayload` DOES surface. No DataKit XML, no `&quot;` encoding — native JSON only.
 */

import { ComponentDependency } from './retrieve.js';

/** One self-describing component file on disk, e.g. `data-cloud/default/calculated-insights/highValueCustomer.json`. */
export type ComponentFile = {
  /** API value of the component type, e.g. "CalculatedInsight". */
  componentType: string;
  /** API/developer name of the component; also the file name stem (deterministic, §5.1). */
  componentName: string;
  /** Developer name of the dataspace this component belongs to. */
  dataspaceName: string;
  /** Direct dependencies (server-resolved); empty array for leaf components. */
  dependsOn: ComponentDependency[];
  /**
   * Type-specific payload, normalized to this camelCase key on disk (§5.1) regardless of whether
   * the API returned `entitypayload` or `data`. Stored verbatim — an object or a string — and never
   * re-parsed, so a serialized-string payload round-trips byte-for-byte on deploy.
   */
  entityPayload: unknown;
};

/** One entry in `manifest.json` `deploymentOrder` (§5.8 — exactly these three keys). */
export type ManifestEntry = {
  componentType: string;
  componentName: string;
  dataspaceName: string;
};

/** Root `data-cloud/manifest.json`: the flattened deployment order for a retrieve (§5.8). */
export type Manifest = {
  /** Every retrieved component (including dataspace-agnostic DLOs), in server deployment order. */
  deploymentOrder: ManifestEntry[];
};
