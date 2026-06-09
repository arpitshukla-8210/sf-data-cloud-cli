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

import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { getMockComponents } from '../../../shared/mocks/components.mock.js';
import { ComponentListResult } from '../../../shared/types/component.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.component.list');

/*
 * Command: sf data-cloud component list
 * Maps to GET /ssot/devops/component-object-api-names?componentType=<>&dataSpaceName=<>
 * (PROJECT_KNOWLEDGE.md §1.7, §5.4).
 * Week 1: returns dummy data from shared/mocks, filtered by --component-type and --dataspace.
 * No org contact yet; --src-org is accepted now to match the PRD UX walkthrough and to be the
 * target of the real auth/connection wiring in Week 2–3.
 * Stays thin — sources data from shared/ so wiring the real API later touches shared/, not this file.
 */
export default class DataCloudComponentList extends SfCommand<ComponentListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  // Supports the alternative PRD walkthrough syntax: `sf data-cloud component-names`.
  // public static readonly aliases = ['data-cloud:component-names'];

  public static readonly flags = {
    'component-type': Flags.string({
      summary: messages.getMessage('flags.component-type.summary'),
      required: true,
      aliases: ['type'],
    }),
    dataspace: Flags.string({
      summary: messages.getMessage('flags.dataspace.summary'),
      required: true,
    }),
    'src-org': Flags.string({
      summary: messages.getMessage('flags.src-org.summary'),
      required: true,
      aliases: ['target-org', 'o'],
    }),
  };

  public async run(): Promise<ComponentListResult> {
    const { flags } = await this.parse(DataCloudComponentList);
    const componentType = flags['component-type'];
    const dataspace = flags.dataspace;

    // Source: dummy data today; swap for a Connect API client in Week 2–3.
    // The mock simulates the endpoint's server-side filtering by type + dataspace (§5.4).
    const { components } = getMockComponents(componentType, dataspace);

    // Human-readable output (auto-suppressed when --json is present).
    this.table({
      data: components,
      columns: [
        { key: 'componentName', name: 'Component Name' },
        { key: 'lastModifiedDate', name: 'Last Modified Date' },
      ],
    });
    this.log(messages.getMessage('info.found', [components.length, componentType, dataspace]));

    // Returned object is what --json emits and what unit tests assert against.
    return { components };
  }
}
