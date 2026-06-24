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
import { deployComponents } from '../../../shared/services/deploy-service.js';
import { DeployResult } from '../../../shared/types/deploy.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.deploy');

/*
 * Command: sf data-cloud deploy
 * Maps to POST /ssot/devops/component/promotion (PROJECT_KNOWLEDGE.md §1.7, §1.10, §5.6).
 * Resolves --target-org to an authenticated connection and delegates to the deploy service, which
 * reads the named component plus its transitive dependencies from the local data-cloud/ tree and
 * submits them for an async deploy. The live backend returns only a submission status
 * ('SUBMITTED') with no jobId; detailed per-job status tracking is not yet available server-side.
 * Stays thin — all sourcing + HTTP lives in shared/services.
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
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'api-version': Flags.orgApiVersion(),
  };

  public async run(): Promise<DeployResult> {
    const { flags } = await this.parse(DataCloudDeploy);
    const conn = flags['target-org'].getConnection(flags['api-version']);

    // Service layer: parse the flag → read local files → walk deps → assemble the payload → POST.
    const result = await deployComponents(conn, flags.component, flags.dataspace);

    // Human-readable output (auto-suppressed when --json is present). The live response is a
    // submission ack ('SUBMITTED') plus the tracking jobId the backend always returns.
    this.log(messages.getMessage('info.submitted', [flags.component, flags.dataspace]));
    this.log(messages.getMessage('info.status', [result.status]));
    this.log(messages.getMessage('info.jobId', [result.jobId]));
    this.log('');
    this.log(messages.getMessage('info.statusNote'));

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
