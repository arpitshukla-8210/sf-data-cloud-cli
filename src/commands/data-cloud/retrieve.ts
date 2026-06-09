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
import { getMockRetrieveResult } from '../../shared/mocks/retrieve.mock.js';
import { RetrieveResult } from '../../shared/types/retrieve.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.retrieve');

/*
 * Command: sf data-cloud retrieve
 * Maps to POST /ssot/devops/retrieve (PROJECT_KNOWLEDGE.md §1.7, §5.5).
 * Week 1: returns a dummy dependency graph from shared/mocks — no org contact, no file writes.
 * --src-org is accepted now to match the PRD UX walkthrough and to be the target of the real
 * auth/connection wiring in Week 2–3.
 * Stays thin — sources data from shared/ so wiring the real API later touches shared/, not this file.
 */
export default class DataCloudRetrieve extends SfCommand<RetrieveResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    component: Flags.string({
      summary: messages.getMessage('flags.component.summary'),
      required: true,
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

  public async run(): Promise<RetrieveResult> {
    const { flags } = await this.parse(DataCloudRetrieve);

    // Source: dummy dependency graph today; swap for a Connect API client in Week 2–3.
    // The mock simulates the server's spidered, deployment-ordered response (§5.5).
    const result = getMockRetrieveResult(flags.component, flags.dataspace);

    // Human-readable output (auto-suppressed when --json is present).
    this.log(messages.getMessage('info.success', [result.retrievedComponents.length]));
    for (const comp of result.retrievedComponents) {
      // The list bullet is rendered here: the message loader strips leading "- " from .md values.
      this.log(`  - ${messages.getMessage('info.componentLine', [comp.componentType, comp.componentName])}`);
    }
    this.log('');
    this.log(messages.getMessage('info.filesWritten', [result.fileWriteLocation]));

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
