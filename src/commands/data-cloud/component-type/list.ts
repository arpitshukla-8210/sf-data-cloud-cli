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
import { getComponentTypes } from '../../../shared/services/devops-api.js';
import { ComponentTypeListResult, ComponentTypeSummary } from '../../../shared/types/component-type.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.component-type.list');

/*
 * Command: sf data-cloud component-type list
 * Maps to GET /ssot/devops/component-types (PROJECT_KNOWLEDGE.md §1.7, §5.3).
 * Resolves --src-org to an authenticated connection and lists the supported component types.
 * Stays thin — the HTTP boundary lives in shared/services/devops-api.
 */
export default class DataCloudComponentTypeList extends SfCommand<ComponentTypeListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'src-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.src-org.summary'),
      aliases: ['target-org'],
    }),
    'api-version': Flags.orgApiVersion(),
  };

  public async run(): Promise<ComponentTypeListResult> {
    const { flags } = await this.parse(DataCloudComponentTypeList);
    const conn = flags['src-org'].getConnection(flags['api-version']);

    const response = await getComponentTypes(conn);

    const componentTypes: ComponentTypeSummary[] = Object.entries(response.supportedComponentTypes).map(
      ([componentType, label]) => ({ componentType, label })
    );

    // Human-readable output (auto-suppressed when --json is present).
    this.table({
      data: componentTypes,
      columns: [
        { key: 'componentType', name: 'Component Type' },
        { key: 'label', name: 'Label' },
      ],
    });
    this.log(messages.getMessage('info.found', [componentTypes.length]));

    // Returned object is what --json emits and what unit tests assert against.
    return { componentTypes };
  }
}
