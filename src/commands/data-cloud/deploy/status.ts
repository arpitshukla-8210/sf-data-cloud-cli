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
import { getMockDeployStatus } from '../../../shared/mocks/deploy-status.mock.js';
import { DeployStatusResult } from '../../../shared/types/deploy-status.js';
import { emitTelemetry } from '../../../shared/services/telemetry.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.deploy.status');

/*
 * Maps a terminal FAILED status to a machine-parseable classification code for agent/CI consumers
 * (§5.7) — never the failing component name or the raw error message. The mock surfaces a single
 * component-level validation failure; the real backend will carry a richer classification to map
 * here later. Only called when status === 'FAILED'.
 */
function deriveDeployErrorCode(result: DeployStatusResult): string {
  return result.components != null ? 'ComponentValidationError' : 'DeployJobFailed';
}

/*
 * Command: sf data-cloud deploy status
 * Maps to GET /ssot/devops/deploy/{jobId}/status (PROJECT_KNOWLEDGE.md §1.7, §5.7).
 * The server endpoint is NOT yet implemented (and the deploy command does not return a real jobId
 * yet), so this command remains mock-backed — it demonstrates the eventual poll UX without an org
 * contact or network call. It will be wired to the real API once the backend lands the status
 * endpoint. --target-org stays a plain string for the same reason (no real connection is used).
 * Stays thin — sources data from shared/ so wiring the real API later touches shared/, not this file.
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
    'target-org': Flags.string({
      summary: messages.getMessage('flags.target-org.summary'),
      required: true,
      aliases: ['o'],
    }),
  };

  public async run(): Promise<DeployStatusResult> {
    const { flags } = await this.parse(DataCloudDeployStatus);

    // Source: dummy status today; swap for a Connect API client in Week 2–3.
    const result = getMockDeployStatus(flags['job-id']);

    // Telemetry (§2.4): the only place real terminal SUCCESS/FAILED is observable (deploy itself
    // returns a synchronous CREATED). This command has no service layer, so the emit lives here —
    // the sanctioned command-layer exception. `void` + the never-throw helper keep run() thin and
    // its return/logging unaffected. Reads only the safe enum and a presence boolean (never the
    // failing component's name or error message).
    const isTerminal = result.status === 'SUCCESS' || result.status === 'FAILED';
    void emitTelemetry('DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL', {
      // correlationId: omitted until deploy backend is live
      lifecycleStatus: result.status,
      isTerminal,
      success: result.status === 'SUCCESS',
      hadComponentError: result.status === 'FAILED' && result.components != null,
      usedJson: this.jsonEnabled(),
      // Machine-parseable classification for agent/CI consumers; present only on a terminal FAILED.
      ...(result.status === 'FAILED' && { errorCode: deriveDeployErrorCode(result) }),
    });

    // Human-readable mapping: the UX mockup surfaces 'SUCCEEDED' for the backend's terminal 'SUCCESS'
    // enum. The returned object (and --json) keeps the raw contract value; only display is mapped.
    const displayStatus = result.status === 'SUCCESS' ? 'SUCCEEDED' : result.status;

    // Human-readable output (auto-suppressed when --json is present).
    this.log(messages.getMessage('info.jobId', [result.jobId]));
    this.log(messages.getMessage('info.status', [displayStatus]));

    // On failure, surface the structured, actionable component error (§5.7 / PROJECT_KNOWLEDGE.md §1.11).
    if (result.status === 'FAILED' && result.components) {
      this.log('');
      this.log(messages.getMessage('error.header', [result.components.componentName]));
      this.log(messages.getMessage('error.reason', [result.components.error]));
    }

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
