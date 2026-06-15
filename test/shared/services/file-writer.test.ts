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
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { folderForComponentType, writeRetrievedComponents } from '../../../src/shared/services/file-writer.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';
import { RawRetrievedComponent } from '../../../src/shared/types/retrieve.js';
import { ComponentFile, Manifest } from '../../../src/shared/types/file-layout.js';

/** Reads a file and returns its exact on-disk bytes as a string (no parsing). */
const readRaw = (path: string): string => readFileSync(path, 'utf8');

/** Builds the canonical on-disk representation: 2-space indent + trailing newline. */
const onDisk = (value: ComponentFile | Manifest): string => `${JSON.stringify(value, null, 2)}\n`;

describe('file-writer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-fw-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('writeRetrievedComponents', () => {
    it('writes each component to its deterministic §5.2 path with normalized entityPayload', async () => {
      const { components } = getMockRetrieveApiResponse('default');
      const [ci, divvy, transform, , account] = components;

      const { filesWritten, manifestPath } = await writeRetrievedComponents(components, { baseDir: tmp });

      // CalculatedInsight — dataspace-scoped, payload from the `entityPayload` object (verbatim).
      const ciPath = join(tmp, 'data-cloud', 'default', 'calculated-insights', 'highValueCustomer.json');
      const expectedCi: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'highValueCustomer',
        dataspaceName: 'default',
        dependsOn: ci.dependsOn,
        entityPayload: ci.entityPayload,
      };
      expect(existsSync(ciPath)).to.be.true;
      expect(readRaw(ciPath)).to.equal(onDisk(expectedCi));

      // DataModelObject (leaf) — dataspace-scoped, payload from the `entityPayload` object.
      const divvyPath = join(tmp, 'data-cloud', 'default', 'data-model-objects', 'Divvy_TripsDmo.json');
      const expectedDivvy: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'Divvy_TripsDmo',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: divvy.entityPayload,
      };
      expect(readRaw(divvyPath)).to.equal(onDisk(expectedDivvy));

      // DataTransform — payload carried through verbatim from the `entityPayload` object.
      const transformPath = join(tmp, 'data-cloud', 'default', 'data-transforms', 'myTransform.json');
      const expectedTransform: ComponentFile = {
        componentType: 'DataTransform',
        componentName: 'myTransform',
        dataspaceName: 'default',
        dependsOn: transform.dependsOn,
        entityPayload: transform.entityPayload,
      };
      expect(readRaw(transformPath)).to.equal(onDisk(expectedTransform));
      expect(expectedTransform.entityPayload).to.be.an('object');

      // DataModelObject (leaf) — payload is the `entityPayload` object, written verbatim.
      const accountPath = join(tmp, 'data-cloud', 'default', 'data-model-objects', 'AccountDmo.json');
      const expectedAccount: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'AccountDmo',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: account.entityPayload,
      };
      expect(readRaw(accountPath)).to.equal(onDisk(expectedAccount));

      // Returned paths reflect what was written, in response order, plus the manifest path.
      expect(filesWritten).to.deep.equal([
        ciPath,
        divvyPath,
        transformPath,
        join(tmp, 'data-cloud', 'data-lake-objects', 'myDLO.json'),
        accountPath,
      ]);
      expect(manifestPath).to.equal(join(tmp, 'data-cloud', 'manifest.json'));
    });

    it('routes a DataLakeObject to the root data-lake-objects/ folder, OUTSIDE the dataspace', async () => {
      const { components } = getMockRetrieveApiResponse('default');
      await writeRetrievedComponents(components, { baseDir: tmp });

      const rootDloPath = join(tmp, 'data-cloud', 'data-lake-objects', 'myDLO.json');
      const dataspaceDloPath = join(tmp, 'data-cloud', 'default', 'data-lake-objects', 'myDLO.json');

      expect(existsSync(rootDloPath)).to.be.true;
      expect(existsSync(dataspaceDloPath)).to.be.false;

      // DLO payload is the `entityPayload` object, written verbatim.
      const dlo = components[3];
      expect(dlo.componentName).to.equal('myDLO');
      const expectedDlo: ComponentFile = {
        componentType: 'DataLakeObject',
        componentName: 'myDLO',
        dataspaceName: 'default',
        dependsOn: dlo.dependsOn,
        entityPayload: dlo.entityPayload,
      };
      expect(readRaw(rootDloPath)).to.equal(onDisk(expectedDlo));
    });

    it('writes a manifest listing ALL components (including the DLO) in response order', async () => {
      const { components } = getMockRetrieveApiResponse('default');
      const { manifestPath } = await writeRetrievedComponents(components, { baseDir: tmp });

      const expectedManifest: Manifest = {
        deploymentOrder: [
          { componentType: 'CalculatedInsight', componentName: 'highValueCustomer', dataspaceName: 'default' },
          { componentType: 'DataModelObject', componentName: 'Divvy_TripsDmo', dataspaceName: 'default' },
          { componentType: 'DataTransform', componentName: 'myTransform', dataspaceName: 'default' },
          { componentType: 'DataLakeObject', componentName: 'myDLO', dataspaceName: 'default' },
          { componentType: 'DataModelObject', componentName: 'AccountDmo', dataspaceName: 'default' },
        ],
      };
      expect(readRaw(manifestPath)).to.equal(onDisk(expectedManifest));
    });

    it('honors a non-default dataspace in the write paths', async () => {
      const { components } = getMockRetrieveApiResponse('analytics_ds');
      await writeRetrievedComponents(components, { baseDir: tmp });

      // Dataspace-scoped component lands under the dataspace folder...
      expect(existsSync(join(tmp, 'data-cloud', 'analytics_ds', 'calculated-insights', 'highValueCustomer.json'))).to.be
        .true;
      // ...but the DLO stays dataspace-agnostic at the root regardless of dataspace.
      expect(existsSync(join(tmp, 'data-cloud', 'data-lake-objects', 'myDLO.json'))).to.be.true;
    });

    it('silently overwrites existing files and manifest on re-retrieve', async () => {
      const { components } = getMockRetrieveApiResponse('default');
      const ciPath = join(tmp, 'data-cloud', 'default', 'calculated-insights', 'highValueCustomer.json');

      // First write, then mutate the on-disk file so we can prove the second write replaces it.
      await writeRetrievedComponents(components, { baseDir: tmp });
      const firstContent = readRaw(ciPath);
      rmSync(ciPath);
      await writeRetrievedComponents(components, { baseDir: tmp });

      expect(existsSync(ciPath)).to.be.true;
      expect(readRaw(ciPath)).to.equal(firstContent);
    });

    it('writes an empty manifest and no component files for an empty response', async () => {
      const { manifestPath } = await writeRetrievedComponents([], { baseDir: tmp });
      expect(readRaw(manifestPath)).to.equal(onDisk({ deploymentOrder: [] }));
    });

    it('writes NOTHING when any one component has an unsupported type (atomic plan-then-write guarantee)', async () => {
      // A valid component FIRST, then one with an unsupported componentType. The path for every
      // component is resolved synchronously up front, so the bad type throws during the plan phase
      // before any I/O. If the writer streamed instead, the good component would land on disk before
      // the bad one threw — so a zero-file tree proves the §4.2 "no partial, half-written tree"
      // guarantee.
      const components: RawRetrievedComponent[] = [
        {
          componentType: 'CalculatedInsight',
          componentName: 'goodCI',
          dataspaceName: 'default',
          dependsOn: [],
          entityPayload: { masterLabel: 'good' },
        },
        {
          componentType: 'NotARealType',
          componentName: 'badType',
          dataspaceName: 'default',
          dependsOn: [],
          entityPayload: {},
        },
      ];

      try {
        await writeRetrievedComponents(components, { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('UnknownComponentTypeError');
        expect((error as Error).message).to.match(/Unknown component type/);
      }

      // The entire data-cloud/ tree is absent: not the good component's file, not the manifest.
      expect(existsSync(join(tmp, 'data-cloud'))).to.be.false;
    });
  });

  describe('folderForComponentType', () => {
    it('maps known types to kebab-case plural folders', () => {
      expect(folderForComponentType('CalculatedInsight')).to.equal('calculated-insights');
      expect(folderForComponentType('DataModelObject')).to.equal('data-model-objects');
      expect(folderForComponentType('DataLakeObject')).to.equal('data-lake-objects');
    });

    it('throws a structured error for an unknown type', () => {
      expect(() => folderForComponentType('NotARealType')).to.throw(/Unknown component type/);
    });
  });
});
