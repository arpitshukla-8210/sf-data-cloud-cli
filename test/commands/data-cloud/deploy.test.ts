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
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { AnyJson } from '@salesforce/ts-types';
import DataCloudDeploy from '../../../src/commands/data-cloud/deploy/index.js';
import { writeRetrievedComponents } from '../../../src/shared/services/file-writer.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';

describe('data-cloud deploy', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  // The command reads the data-cloud/ tree from process.cwd(); isolate it in a throwaway dir and
  // pre-populate it with exactly what retrieve writes, so deploy has real files to read.
  let origCwd: string;
  let tmp: string;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    // The deploy POST is faked at the HTTP boundary; the backend returns a SUBMITTED ack + jobId.
    $$.fakeConnectionRequest = (): Promise<AnyJson> =>
      Promise.resolve({ status: 'SUBMITTED', jobId: '08PVF000002iQIb' } as unknown as AnyJson);
    origCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'dc-deploy-cmd-'));
    process.chdir(tmp);
    const { components } = getMockRetrieveApiResponse('default');
    await writeRetrievedComponents(components, { baseDir: tmp });
  });

  afterEach(() => {
    // Restore cwd FIRST so a later cleanup throw can't strand the process in the temp dir.
    process.chdir(origCwd);
    $$.restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('submits an async deploy and returns the SUBMITTED status with its jobId', async () => {
    const result = await DataCloudDeploy.run([
      '--component',
      'CalculatedInsight:highValueCustomer',
      '--dataspace',
      'default',
      '--target-org',
      testOrg.username,
    ]);

    // Matches the synchronous deploy response: { status: 'SUBMITTED', jobId }.
    expect(result.status).to.equal('SUBMITTED');
    expect(result.jobId).to.equal('08PVF000002iQIb');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    // Echoes the requested component + dataspace, the submission status, the jobId, and the note.
    expect(output).to.include('Deployment submitted for CalculatedInsight:highValueCustomer in dataspace default');
    expect(output).to.include('Status: SUBMITTED');
    expect(output).to.include('Job ID: 08PVF000002iQIb');
    // Points the user at the now-live status command, threading the tracking jobId through.
    expect(output).to.include('Track progress with:');
    expect(output).to.include('data-cloud deploy status --job-id 08PVF000002iQIb');
  });

  it('fails if the required target-org flag is missing and no default org is configured', async () => {
    try {
      await DataCloudDeploy.run(['--component', 'CalculatedInsight:highValueCustomer', '--dataspace', 'default']);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/org|target-org|default environment/i);
    }
  });
});
