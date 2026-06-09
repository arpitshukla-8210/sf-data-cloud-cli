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

import { SfCommand } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { getMockComponentTypes } from '../../../shared/mocks/component-types.mock.js';
import { ComponentTypeListResult, ComponentTypeSummary } from '../../../shared/types/component-type.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.component-type.list');

/*
 * Command: sf data-cloud component-type list
 * Maps to GET /ssot/devops/component-types (PROJECT_KNOWLEDGE.md §1.7, §5.3).
 * Week 1: returns dummy data from shared/mocks. No flags, no org contact.
 * Stays thin — sources data from shared/ so wiring the real API later touches shared/, not this file.
 */
export default class DataCloudComponentTypeList extends SfCommand<ComponentTypeListResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  // No flags required for this command (PROJECT_KNOWLEDGE.md §2.1).
  public static readonly flags = {};

  public async run(): Promise<ComponentTypeListResult> {
    // Parse to honor global flags (e.g. --json) and stay consistent with flag-bearing commands.
    await this.parse(DataCloudComponentTypeList);

    // Source: dummy data today; swap for a Connect API client in Week 2–3.
    const response = getMockComponentTypes();

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
