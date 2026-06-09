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
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import DataCloudDeployStatus from '../../../../src/commands/data-cloud/deploy/status.js';

describe('data-cloud deploy status', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('maps the SUCCESS backend payload to a SUCCEEDED human-readable status', async () => {
    const result = await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb', '--target-org', 'uat-org']);

    // The returned object keeps the raw contract value (§5.7); only the display is mapped.
    expect(result.status).to.equal('SUCCESS');
    expect(result.jobId).to.equal('08PVF000002iQIb');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Job ID: 08PVF000002iQIb');
    expect(output).to.include('Status: SUCCEEDED');
  });

  it('reports the failing component and reason on a FAILED job', async () => {
    const result = await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb-fail', '--target-org', 'uat-org']);

    expect(result.status).to.equal('FAILED');
    expect(result.components?.componentName).to.equal('HighValueCustomers');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Status: FAILED');
    expect(output).to.include("Error details for component 'HighValueCustomers':");
    expect(output).to.include(
      'Reason: Component validation failed: Calculated Insight expression contains an invalid syntax'
    );
  });

  it('fails if the required job-id flag is missing', async () => {
    try {
      await DataCloudDeployStatus.run(['--target-org', 'uat-org']);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Missing required flag job-id');
    }
  });
});
