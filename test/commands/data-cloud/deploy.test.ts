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
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import DataCloudDeploy from '../../../src/commands/data-cloud/deploy.js';
import { writeRetrievedComponents } from '../../../src/shared/services/file-writer.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';

describe('data-cloud deploy', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  // The command reads the data-cloud/ tree from process.cwd(); isolate it in a throwaway dir and
  // pre-populate it with exactly what retrieve writes, so deploy has real files to read.
  let origCwd: string;
  let tmp: string;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
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

  it('starts an async deploy and returns a tracking jobId in the CREATED state', async () => {
    const result = await DataCloudDeploy.run([
      '--component',
      'CalculatedInsight:highValueCustomer',
      '--dataspace',
      'default',
      '--target-org',
      'uat-org',
    ]);

    // Matches the synchronous deploy response contract (§5.6): { jobId, CREATED }.
    expect(result.status).to.equal('CREATED');
    expect(result.jobId).to.equal('08PVF000002iQIb');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    // Echoes the requested component + dataspace, the jobId, the real CREATED status, and a poll hint.
    expect(output).to.include('Deployment started for CalculatedInsight:highValueCustomer in dataspace default');
    expect(output).to.include('Job ID: 08PVF000002iQIb');
    expect(output).to.include('Status: CREATED');
    expect(output).to.include('sf data-cloud deploy status --job-id 08PVF000002iQIb --target-org uat-org');
  });

  it('fails if the required target-org flag is missing', async () => {
    try {
      await DataCloudDeploy.run(['--component', 'CalculatedInsight:highValueCustomer', '--dataspace', 'default']);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Missing required flag target-org');
    }
  });
});
