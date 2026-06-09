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
import DataCloudRetrieve from '../../../src/commands/data-cloud/retrieve.js';

describe('data-cloud retrieve', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
  });

  afterEach(() => {
    $$.restore();
  });

  it('returns dependency graph structure and prints output logs matching the PRD exactly', async () => {
    const result = await DataCloudRetrieve.run([
      '--component',
      'CalculatedInsight:highValueCustomer',
      '--dataspace',
      'default',
      '--src-org',
      'testOrg1',
    ]);

    expect(result.retrievedComponents).to.have.lengthOf(5);
    expect(result.retrievedComponents[0].componentName).to.equal('highValueCustomer');
    expect(result.targetComponent).to.equal('CalculatedInsight:highValueCustomer');
    expect(result.dataspace).to.equal('default');

    // Standardized shape only: no raw payload (entitypayload / data) leaks into the result.
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
      'testOrg1',
    ]);
    expect(result.dataspace).to.equal('analytics_ds');
    expect(result.fileWriteLocation).to.equal('./data-cloud/analytics_ds/');
    expect(result.retrievedComponents.every((c) => c.dataspaceName === 'analytics_ds')).to.be.true;
  });

  it('fails if required flags are missing', async () => {
    try {
      await DataCloudRetrieve.run(['--dataspace', 'default']);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Missing required flag component');
    }
  });
});
