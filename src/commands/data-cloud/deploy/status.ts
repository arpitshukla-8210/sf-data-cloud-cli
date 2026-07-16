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
import { checkDeployStatus } from '../../../shared/services/deploy-status-service.js';
import { DeployStatusResult } from '../../../shared/types/deploy-status.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.deploy.status');

/*
 * Command: sf data-cloud deploy status
 * Maps to GET /ssot/devops/component/promotion/{jobId} (PROJECT_KNOWLEDGE.md §1.7, §5.7).
 * Resolves --target-org to an authenticated connection and delegates to the deploy-status service,
 * which polls the async deploy job and normalizes the backend's PascalCase enums to the CLI's
 * UPPERCASE vocabulary. Stays thin — all HTTP, mapping, and telemetry live in shared/services.
 */
export default class DataCloudDeployStatus extends SfCommand<DeployStatusResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'job-id': Flags.string({
      summary: messages.getMessage('flags.job-id.summary'),
      required: true,
      aliases: ['i'],
    }),
    'target-org': Flags.requiredOrg({
      summary: messages.getMessage('flags.target-org.summary'),
    }),
    'api-version': Flags.orgApiVersion(),
  };

  public async run(): Promise<DeployStatusResult> {
    const { flags } = await this.parse(DataCloudDeployStatus);
    const conn = flags['target-org'].getConnection(flags['api-version']);

    // Service layer: GET the job status → normalize PascalCase enums → emit telemetry.
    const result = await checkDeployStatus(conn, flags['job-id']);

    // Human-readable output (auto-suppressed when --json is present). The UX mockup surfaces
    // 'SUCCEEDED' for the backend's terminal 'SUCCESS' enum; the returned object (and --json) keeps
    // the raw contract value, so only display is mapped.
    this.log(messages.getMessage('info.jobId', [result.jobId]));
    this.log(messages.getMessage('info.status', [result.status === 'SUCCESS' ? 'SUCCEEDED' : result.status]));

    // Per-component status table (mirrors `component list`). Empty when the job is CREATED (queued).
    if (result.components.length > 0) {
      this.table({
        data: result.components.map((c) => ({
          componentName: c.componentName,
          componentType: c.componentType,
          status: c.status === 'SUCCESS' ? 'SUCCEEDED' : c.status,
        })),
        columns: [
          { key: 'componentName', name: 'Component' },
          { key: 'componentType', name: 'Type' },
          { key: 'status', name: 'Status' },
        ],
      });
    }

    // Surface the structured, actionable reason for each failed component (§5.7 / §1.11).
    for (const c of result.components) {
      if (c.status === 'FAILED' && c.error) {
        this.log('');
        this.log(messages.getMessage('error.header', [c.componentName]));
        this.log(messages.getMessage('error.reason', [c.error]));
      }
    }

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
