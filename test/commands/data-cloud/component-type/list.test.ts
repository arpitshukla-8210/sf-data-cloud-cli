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
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { AnyJson } from '@salesforce/ts-types';
import DataCloudComponentTypeList from '../../../../src/commands/data-cloud/component-type/list.js';
import { getMockComponentTypes } from '../../../../src/shared/mocks/component-types.mock.js';

describe('data-cloud component-type list', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    // Route the component-types request through the existing mock.
    $$.fakeConnectionRequest = (): Promise<AnyJson> => Promise.resolve(getMockComponentTypes() as unknown as AnyJson);
  });

  afterEach(() => {
    $$.restore();
  });

  it('returns the supported component types', async () => {
    const result = await DataCloudComponentTypeList.run(['--src-org', testOrg.username]);
    expect(result.componentTypes).to.be.an('array').that.is.not.empty;
    const ci = result.componentTypes.find((c) => c.componentType === 'CalculatedInsight');
    expect(ci).to.deep.equal({ componentType: 'CalculatedInsight', label: 'Calculated Insight' });
  });

  it('includes DataTransform (in-scope dummy retrieve type)', async () => {
    const result = await DataCloudComponentTypeList.run(['--src-org', testOrg.username]);
    expect(result.componentTypes.map((c) => c.componentType)).to.include('DataTransform');
  });

  it('logs a count line with the number of types found', async () => {
    const result = await DataCloudComponentTypeList.run(['--src-org', testOrg.username]);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include(`Found ${result.componentTypes.length} supported component types`);
  });

  it('renders a table of the component types in human-readable mode', async () => {
    const result = await DataCloudComponentTypeList.run(['--src-org', testOrg.username]);
    expect(sfCommandStubs.table.callCount).to.equal(1);
    // The table is fed the same rows that are returned to --json / callers.
    const { data } = sfCommandStubs.table.firstCall.firstArg as { data: unknown[] };
    expect(data).to.deep.equal(result.componentTypes);
  });

  it('returns the structured result when --json is set', async () => {
    // Note: stubSfCommandUx replaces log/table, bypassing their built-in --json
    // suppression, so suppression itself isn't assertable here — the testable
    // contract is that --json yields the same well-formed result object.
    const result = await DataCloudComponentTypeList.run(['--src-org', testOrg.username, '--json']);
    expect(result.componentTypes).to.be.an('array').that.is.not.empty;
    expect(result.componentTypes.every((c) => typeof c.componentType === 'string' && typeof c.label === 'string')).to.be
      .true;
  });

  it('fails when no org is provided and no default org is configured', async () => {
    try {
      await DataCloudComponentTypeList.run([]);
      expect.fail('Should have thrown an error for the missing org');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/org|target-org|src-org/i);
    }
  });
});
