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
import { getComponents } from '../../../shared/services/devops-api.js';
import { ComponentListResult } from '../../../shared/types/component.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.component.list');

/*
 * Command: sf data-cloud component list
 * Maps to GET /ssot/devops/component/catalog?componentType=<>&dataSpaceName=<>
 * (PROJECT_KNOWLEDGE.md §1.7, §5.4).
 * Resolves --src-org to an authenticated connection and lists the components of the requested type
 * within the dataspace (the server applies the type + dataspace filtering).
 * Stays thin — the HTTP boundary lives in shared/services/devops-api.
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
    }),
    'src-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.src-org.summary'),
      aliases: ['target-org'],
    }),
    'api-version': Flags.orgApiVersion(),
  };

  public async run(): Promise<ComponentListResult> {
    const { flags } = await this.parse(DataCloudComponentList);
    const componentType = flags['component-type'];
    const dataspace = flags.dataspace;
    const conn = flags['src-org'].getConnection(flags['api-version']);

    // The server applies the type + dataspace filtering (§5.4); dataspace is omitted when not given.
    const { components } = await getComponents(conn, componentType, dataspace);

    // Human-readable output (auto-suppressed when --json is present).
    this.table({
      data: components,
      columns: [{ key: 'componentName', name: 'Component Name' }],
    });
    // Drop the dataspace clause when none was provided (avoids "in dataspace 'undefined'").
    this.log(
      dataspace
        ? messages.getMessage('info.found', [components.length, componentType, dataspace])
        : messages.getMessage('info.foundNoDataspace', [components.length, componentType])
    );

    // Returned object is what --json emits and what unit tests assert against.
    return { components };
  }
}
