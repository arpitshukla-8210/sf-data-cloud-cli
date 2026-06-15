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
import DataCloudRetrieve from '../../../src/commands/data-cloud/retrieve.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  type TelemetryEvent,
} from '../../shared/telemetry-test-utils.js';

describe('data-cloud retrieve', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  // The command writes the data-cloud/ tree under process.cwd(); isolate it in a throwaway dir so
  // tests never dirty the repo (data-cloud/ is not gitignored) and never leak across runs.
  let origCwd: string;
  let tmp: string;
  let telemetry: TelemetryEvent[];

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    telemetry = [];
    captureTelemetry(telemetry);
    await $$.stubAuths(testOrg);
    // Route the snapshot request through the existing mock, keyed on the requested dataspace so
    // non-default cases echo correctly. The command/service path is exercised; only HTTP is faked.
    $$.fakeConnectionRequest = (request: AnyJson): Promise<AnyJson> => {
      const url = typeof request === 'string' ? request : '';
      const dataspace = new URL(url, 'https://example.com').searchParams.get('dataSpaceName') ?? 'default';
      return Promise.resolve(getMockRetrieveApiResponse(dataspace) as unknown as AnyJson);
    };
    origCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'dc-cmd-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    // Restore cwd FIRST so a later cleanup throw can't strand the process in the temp dir.
    process.chdir(origCwd);
    resetTelemetry();
    $$.restore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns dependency graph structure and prints output logs matching the PRD exactly', async () => {
    const result = await DataCloudRetrieve.run([
      '--component',
      'CalculatedInsight:highValueCustomer',
      '--dataspace',
      'default',
      '--src-org',
      testOrg.username,
    ]);

    expect(result.retrievedComponents).to.have.lengthOf(5);
    expect(result.retrievedComponents[0].componentName).to.equal('highValueCustomer');
    expect(result.targetComponent).to.equal('CalculatedInsight:highValueCustomer');
    expect(result.dataspace).to.equal('default');

    // Standardized shape only: no raw `entityPayload` leaks into the result.
    expect(result.retrievedComponents[0]).to.have.all.keys(
      'componentType',
      'componentName',
      'dataspaceName',
      'dependsOn'
    );
    expect(result.retrievedComponents[0].dependsOn).to.deep.equal([
      { componentName: 'Divvy_TripsDmo', componentType: 'DataModelObject' },
    ]);
    // A leaf dependency carries an empty dependsOn array.
    expect(result.retrievedComponents[1].dependsOn).to.have.lengthOf(0);

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Retrieved 5 components');
    expect(output).to.include('- CalculatedInsight:highValueCustomer');
    expect(output).to.include('- DataModelObject:Divvy_TripsDmo');
    expect(output).to.include('Files written to ./data-cloud/default/');
  });

  it('echoes a non-default dataspace into the result and write location', async () => {
    const result = await DataCloudRetrieve.run([
      '--component',
      'CalculatedInsight:highValueCustomer',
      '--dataspace',
      'analytics_ds',
      '--src-org',
      testOrg.username,
    ]);
    expect(result.dataspace).to.equal('analytics_ds');
    expect(result.fileWriteLocation).to.equal('./data-cloud/analytics_ds/');
    expect(result.retrievedComponents.every((c) => c.dataspaceName === 'analytics_ds')).to.be.true;
  });

  it('fails if the required --component flag is missing', async () => {
    try {
      // Org is provided (resolved in beforeEach); --component is the missing required flag.
      await DataCloudRetrieve.run(['--dataspace', 'default', '--src-org', testOrg.username]);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Missing required flag component');
    }
  });

  it('fails when no org is provided and no default org is configured', async () => {
    try {
      await DataCloudRetrieve.run(['--component', 'CalculatedInsight:highValueCustomer', '--dataspace', 'default']);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/org|target-org|src-org|default environment/i);
    }
  });

  it('emits exactly one safe telemetry event end-to-end (the thin command does not re-emit)', async () => {
    await DataCloudRetrieve.run([
      '--component',
      'CalculatedInsight:highValueCustomer',
      '--dataspace',
      'analytics_ds',
      '--src-org',
      testOrg.username,
    ]);

    // Exactly one event from the service layer — the command adds none of its own.
    const events = ourEvents(telemetry);
    expect(events).to.have.lengthOf(1);
    expect(events[0].eventName).to.equal('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT');
    // Even with flags in scope at the command layer, no flag VALUE (the 'analytics_ds' dataspace or
    // the org username) leaks into the payload.
    assertAllSafe(telemetry);
  });
});
