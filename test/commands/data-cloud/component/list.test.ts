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
import DataCloudComponentList from '../../../../src/commands/data-cloud/component/list.js';
import { getMockComponents } from '../../../../src/shared/mocks/components.mock.js';

describe('data-cloud component list', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    // The catalog endpoint filters by type + dataspace server-side; the mock reproduces that
    // (including the case-insensitive matching the cases below rely on). Pull the params off the URL.
    $$.fakeConnectionRequest = (request: AnyJson): Promise<AnyJson> => {
      const params = new URL(typeof request === 'string' ? request : '', 'https://example.com').searchParams;
      const componentType = params.get('componentType') ?? '';
      const dataSpaceName = params.get('dataSpaceName') ?? '';
      return Promise.resolve(getMockComponents(componentType, dataSpaceName) as unknown as AnyJson);
    };
  });

  afterEach(() => {
    $$.restore();
  });

  it('returns components matching CalculatedInsight in the default dataspace', async () => {
    const result = await DataCloudComponentList.run([
      '--component-type',
      'CalculatedInsight',
      '--dataspace',
      'default',
      '--src-org',
      testOrg.username,
    ]);
    expect(result.components).to.be.an('array').with.lengthOf(3);
    expect(result.components[0].componentName).to.equal('HighValueCustomers');
    // Result rows carry only the documented §5.4 keys — no internal fixture fields leak.
    expect(result.components[0]).to.have.all.keys('componentName');
    expect(result.components.map((c) => c.componentName)).to.deep.equal([
      'HighValueCustomers',
      'ChurnRiskScore',
      'LTVForecast',
    ]);
  });

  it('honors custom (non-default) dataspaces', async () => {
    const result = await DataCloudComponentList.run([
      '--component-type',
      'DataTransform',
      '--dataspace',
      'analytics_ds',
      '--src-org',
      testOrg.username,
    ]);
    expect(result.components).to.have.lengthOf(1);
    expect(result.components[0].componentName).to.equal('Custom_Transform_Engine');
  });

  it('returns an empty list when type and dataspace do not match', async () => {
    const result = await DataCloudComponentList.run([
      '--component-type',
      'CalculatedInsight',
      '--dataspace',
      'analytics_ds',
      '--src-org',
      testOrg.username,
    ]);
    expect(result.components).to.be.an('array').that.is.empty;
  });

  it('matches type and dataspace case-insensitively', async () => {
    const result = await DataCloudComponentList.run([
      '--component-type',
      'calculatedinsight',
      '--dataspace',
      'DEFAULT',
      '--src-org',
      testOrg.username,
    ]);
    expect(result.components).to.have.lengthOf(3);
  });

  it('logs a count line naming the type and dataspace', async () => {
    const result = await DataCloudComponentList.run([
      '--component-type',
      'CalculatedInsight',
      '--dataspace',
      'default',
      '--src-org',
      testOrg.username,
    ]);
    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include(`Found ${result.components.length} components matching type 'CalculatedInsight'`);
    expect(output).to.include("in dataspace 'default'");
  });

  it('renders a table fed the same rows returned to callers', async () => {
    const result = await DataCloudComponentList.run([
      '--component-type',
      'CalculatedInsight',
      '--dataspace',
      'default',
      '--src-org',
      testOrg.username,
    ]);
    expect(sfCommandStubs.table.callCount).to.equal(1);
    const { data } = sfCommandStubs.table.firstCall.firstArg as { data: unknown[] };
    expect(data).to.deep.equal(result.components);
  });

  it('fails when no org is provided and no default org is configured', async () => {
    try {
      // No --src-org and no default target-org config: requiredOrg cannot resolve an org.
      await DataCloudComponentList.run(['--component-type', 'CalculatedInsight', '--dataspace', 'default']);
      expect.fail('Should have thrown an error for the missing org');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/org|target-org|src-org/i);
    }
  });
});
