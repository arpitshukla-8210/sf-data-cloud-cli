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
import { retrieveComponents } from '../../shared/services/retrieve-service.js';
import { RetrieveResult } from '../../shared/types/retrieve.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.retrieve');

/*
 * Command: sf data-cloud retrieve
 * Maps to POST /ssot/devops/retrieve (PROJECT_KNOWLEDGE.md §1.7, §5.5).
 * Week 1: delegates to the retrieve service, which sources a dummy dependency graph and writes one
 * JSON file per component to the local data-cloud/ tree (§5.2) plus a manifest (§5.8). No org
 * contact yet — --src-org is accepted to match the PRD UX walkthrough and to be the target of the
 * real auth/connection wiring in Week 2–3.
 * Stays thin — all sourcing + persistence lives in shared/services, so wiring the real API later
 * touches shared/, not this file.
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

    // The service sources the (currently dummy) response, persists each component to disk (§5.2),
    // and returns the standardized result with raw payloads stripped. Writes under process.cwd().
    const result = await retrieveComponents(flags.component, flags.dataspace);

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
