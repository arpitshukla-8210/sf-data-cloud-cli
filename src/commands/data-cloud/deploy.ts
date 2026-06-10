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
import { deployComponents } from '../../shared/services/deploy-service.js';
import { DeployResult } from '../../shared/types/deploy.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.deploy');

/*
 * Command: sf data-cloud deploy
 * Maps to POST /ssot/devops/deploy (PROJECT_KNOWLEDGE.md §1.7, §1.10, §5.6).
 * Week 1: returns a dummy { jobId, CREATED } from shared/mocks — no org contact, no network call.
 * The deploy is async: this command returns immediately with a tracking jobId; clients poll
 * `sf data-cloud deploy status` until SUCCESS | FAILED.
 * --target-org is accepted now to match the PRD UX walkthrough and to be the target of the real
 * auth/connection wiring in Week 2–3.
 * Stays thin — sources data from shared/ so wiring the real API later touches shared/, not this file.
 */
export default class DataCloudDeploy extends SfCommand<DeployResult> {
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
    'target-org': Flags.string({
      summary: messages.getMessage('flags.target-org.summary'),
      required: true,
      aliases: ['o'],
    }),
  };

  public async run(): Promise<DeployResult> {
    const { flags } = await this.parse(DataCloudDeploy);

    // Service layer: parse the flag → read local files → walk deps → assemble the payload → mock POST.
    // When the real Connect API is ready, only deploy-service.ts changes (a one-line swap).
    const result = await deployComponents(flags.component, flags.dataspace);

    // Human-readable output (auto-suppressed when --json is present).
    // We report the real CREATED state from the contract (§5.6) — the job advances to INPROGRESS,
    // then SUCCESS | FAILED, which the user polls via `deploy status`.
    this.log(messages.getMessage('info.started', [flags.component, flags.dataspace]));
    this.log(messages.getMessage('info.jobId', [result.jobId]));
    this.log(messages.getMessage('info.status', [result.status]));
    this.log('');
    this.log(messages.getMessage('info.pollHint', [result.jobId, flags['target-org']]));

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
