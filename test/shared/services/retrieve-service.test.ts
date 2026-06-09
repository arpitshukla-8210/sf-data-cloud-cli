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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { retrieveComponents } from '../../../src/shared/services/retrieve-service.js';

describe('retrieve-service', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-svc-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the standardized result and writes the data-cloud tree to baseDir', async () => {
    const result = await retrieveComponents('CalculatedInsight:highValueCustomer', 'default', { baseDir: tmp });

    // Standardized RetrieveResult shape (unchanged from Phase 1).
    expect(result.dataspace).to.equal('default');
    expect(result.targetComponent).to.equal('CalculatedInsight:highValueCustomer');
    expect(result.fileWriteLocation).to.equal('./data-cloud/default/');
    expect(result.retrievedComponents).to.have.lengthOf(5);
    expect(result.retrievedComponents[0].componentName).to.equal('highValueCustomer');

    // No raw payload leaks: every component carries exactly the four standardized keys.
    for (const component of result.retrievedComponents) {
      expect(component).to.have.all.keys('componentType', 'componentName', 'dataspaceName', 'dependsOn');
    }

    // Files + manifest landed under the provided baseDir.
    expect(existsSync(join(tmp, 'data-cloud', 'default', 'calculated-insights', 'highValueCustomer.json'))).to.equal(
      true
    );
    expect(existsSync(join(tmp, 'data-cloud', 'data-lake-objects', 'myDLO.json'))).to.equal(true);
    expect(existsSync(join(tmp, 'data-cloud', 'manifest.json'))).to.equal(true);
  });

  it('echoes a non-default dataspace into the result and the write paths', async () => {
    const result = await retrieveComponents('CalculatedInsight:highValueCustomer', 'analytics_ds', { baseDir: tmp });

    expect(result.dataspace).to.equal('analytics_ds');
    expect(result.fileWriteLocation).to.equal('./data-cloud/analytics_ds/');
    expect(result.retrievedComponents.every((c) => c.dataspaceName === 'analytics_ds')).to.equal(true);
    expect(
      existsSync(join(tmp, 'data-cloud', 'analytics_ds', 'calculated-insights', 'highValueCustomer.json'))
    ).to.equal(true);
  });
});
