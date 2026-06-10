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
import { expect } from 'chai';
import {
  parseComponentFlag,
  assembleDeployRequest,
  deployComponents,
} from '../../../src/shared/services/deploy-service.js';
import { writeRetrievedComponents } from '../../../src/shared/services/file-writer.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';
import { ComponentFile } from '../../../src/shared/types/file-layout.js';

describe('deploy-service', () => {
  describe('parseComponentFlag', () => {
    it('parses a valid TYPE:NAME', () => {
      expect(parseComponentFlag('CalculatedInsight:highValueCustomer')).to.deep.equal({
        componentType: 'CalculatedInsight',
        componentName: 'highValueCustomer',
      });
    });

    it('handles names with underscores and digits', () => {
      expect(parseComponentFlag('DataModelObject:Divvy_TripsDmo2')).to.deep.equal({
        componentType: 'DataModelObject',
        componentName: 'Divvy_TripsDmo2',
      });
    });

    it('throws InvalidComponentFlagError when the colon is missing', () => {
      expect(() => parseComponentFlag('BadFormat')).to.throw(/Expected TYPE:NAME/);
    });

    it('throws InvalidComponentFlagError for an empty type (":name")', () => {
      expect(() => parseComponentFlag(':highValueCustomer')).to.throw(/Expected TYPE:NAME/);
    });

    it('throws InvalidComponentFlagError for an empty name ("Type:")', () => {
      expect(() => parseComponentFlag('CalculatedInsight:')).to.throw(/Expected TYPE:NAME/);
    });
  });

  describe('assembleDeployRequest', () => {
    it('renames entityPayload→data, drops per-component dataspaceName, lifts dataSpaceName to top', () => {
      const components: ComponentFile[] = [
        {
          componentType: 'CalculatedInsight',
          componentName: 'CI',
          dataspaceName: 'default',
          dependsOn: [{ componentName: 'Dmo', componentType: 'DataModelObject' }],
          entityPayload: { masterLabel: 'testCI' },
        },
      ];
      const request = assembleDeployRequest(components, 'default');

      expect(request.dataSpaceName).to.equal('default');
      expect(request.components).to.have.lengthOf(1);
      expect(request.components[0]).to.deep.equal({
        componentName: 'CI',
        componentType: 'CalculatedInsight',
        dependsOn: [{ componentName: 'Dmo', componentType: 'DataModelObject' }],
        data: { masterLabel: 'testCI' },
      });
      // No dataspaceName leaks onto a component.
      expect(request.components[0]).to.not.have.property('dataspaceName');
    });

    it('passes a string payload through verbatim (not re-parsed into an object)', () => {
      const components: ComponentFile[] = [
        {
          componentType: 'DataTransform',
          componentName: 'T',
          dataspaceName: 'default',
          dependsOn: [],
          entityPayload: '{ "label": "My Transform", "type": "BATCH" }',
        },
      ];
      const request = assembleDeployRequest(components, 'default');
      expect(request.components[0].data).to.equal('{ "label": "My Transform", "type": "BATCH" }');
      expect(request.components[0].data).to.be.a('string');
    });
  });

  describe('deployComponents', () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'dc-deploy-svc-'));
      const { components } = getMockRetrieveApiResponse('default');
      await writeRetrievedComponents(components, { baseDir: tmp });
    });

    afterEach(() => {
      rmSync(tmp, { recursive: true, force: true });
    });

    it('deploys a component + its transitive deps and returns { jobId, CREATED }', async () => {
      const result = await deployComponents('CalculatedInsight:highValueCustomer', 'default', { baseDir: tmp });
      expect(result.status).to.equal('CREATED');
      expect(result.jobId).to.equal('08PVF000002iQIb');
    });

    it('resolves a DataLakeObject dependency from the root path (Transform → DLO → DMO)', async () => {
      // Exercises the full chain: read transform (dataspace-scoped) → walk to DLO (root) + DMO.
      const result = await deployComponents('DataTransform:myTransform', 'default', { baseDir: tmp });
      expect(result.status).to.equal('CREATED');
    });

    it('throws ComponentNotFoundError when the named component is missing', async () => {
      try {
        await deployComponents('CalculatedInsight:doesNotExist', 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('ComponentNotFoundError');
      }
    });
  });
});
