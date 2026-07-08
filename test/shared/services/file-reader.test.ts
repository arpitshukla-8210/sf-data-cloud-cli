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
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import {
  pathForComponent,
  readComponentFile,
  collectTransitiveDependencies,
} from '../../../src/shared/services/file-reader.js';
import { ComponentFile } from '../../../src/shared/types/file-layout.js';

/** Writes a ComponentFile to its §5.2 on-disk location (2-space indent + trailing newline). */
const writeFixture = async (tmp: string, file: ComponentFile): Promise<string> => {
  const path = pathForComponent(file.componentType, file.componentName, file.dataspaceName, tmp);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return path;
};

/** Sorted "type:name" keys — for order-independent set assertions on the concurrent walk. */
const keysOf = (files: ComponentFile[]): string[] => files.map((f) => `${f.componentType}:${f.componentName}`).sort();

describe('file-reader', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-fr-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('pathForComponent', () => {
    it('routes a dataspace-scoped type under <base>/data-cloud/<ds>/<folder>/<name>.json', () => {
      expect(pathForComponent('CalculatedInsight', 'highValueCustomer', 'default', tmp)).to.equal(
        join(tmp, 'data-cloud', 'default', 'calculated-insights', 'highValueCustomer.json')
      );
    });

    it('routes a DataLakeObject to the root data-lake-objects/ folder (outside the dataspace)', () => {
      expect(pathForComponent('DataLakeObject', 'myDLO', 'default', tmp)).to.equal(
        join(tmp, 'data-cloud', 'data-lake-objects', 'myDLO.json')
      );
    });

    it('routes a dataspace-scoped type with an empty dataspace to the root folder', () => {
      expect(pathForComponent('CalculatedInsight', 'rootless', '', tmp)).to.equal(
        join(tmp, 'data-cloud', 'calculated-insights', 'rootless.json')
      );
    });

    it('derives a folder for a brand-new type so it can be read back with no CLI change', () => {
      // A type the CLI has never heard of resolves to the same kebab-plural folder the writer used.
      expect(pathForComponent('DataMesh', 'myMesh', 'default', tmp)).to.equal(
        join(tmp, 'data-cloud', 'default', 'data-meshes', 'myMesh.json')
      );
    });

    it('throws InvalidComponentTypeError for an empty/blank type', () => {
      expect(() => pathForComponent('', 'x', 'default', tmp)).to.throw(/empty or invalid/);
      expect(() => pathForComponent('   ', 'x', 'default', tmp)).to.throw(/empty or invalid/);
    });
  });

  describe('readComponentFile', () => {
    it('reads a dataspace-scoped component (CI) and returns the full ComponentFile', async () => {
      const ci: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'highValueCustomer',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'Divvy_TripsDmo', componentType: 'DataModelObject' }],
        entityPayload: { masterLabel: 'testCI', definitionType: 'CALCULATED_METRIC' },
      };
      await writeFixture(tmp, ci);

      const result = await readComponentFile('CalculatedInsight', 'highValueCustomer', 'default', { baseDir: tmp });
      expect(result).to.deep.equal(ci);
    });

    it('reads a DataLakeObject from the root path (outside the dataspace)', async () => {
      const dlo: ComponentFile = {
        componentType: 'DataLakeObject',
        componentName: 'myDLO',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: '{ "type": "DLO", "developerName": "myDLO" }',
      };
      await writeFixture(tmp, dlo);

      const result = await readComponentFile('DataLakeObject', 'myDLO', 'default', { baseDir: tmp });
      expect(result.componentName).to.equal('myDLO');
    });

    it('preserves a string entityPayload verbatim (no re-parsing)', async () => {
      const transform: ComponentFile = {
        componentType: 'DataTransform',
        componentName: 'myTransform',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: '{ "label": "My Transform", "type": "BATCH" }',
      };
      await writeFixture(tmp, transform);

      const result = await readComponentFile('DataTransform', 'myTransform', 'default', { baseDir: tmp });
      expect(result.entityPayload).to.equal('{ "label": "My Transform", "type": "BATCH" }');
      expect(result.entityPayload).to.be.a('string'); // NOT parsed into an object
    });

    it('reads a component with an empty dataspace from the root path', async () => {
      const rootless: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'rootless',
        dataspaceName: '',
        dependsOn: [],
        entityPayload: { masterLabel: 'rootless' },
      };
      await writeFixture(tmp, rootless); // routed to data-cloud/calculated-insights/ (root)

      const result = await readComponentFile('CalculatedInsight', 'rootless', '', { baseDir: tmp });
      expect(result).to.deep.equal(rootless);
    });

    it('finds a root-stored component via root-first lookup even when a dataspace is passed', async () => {
      // Physically stored at the root (empty dataspaceName) ...
      const rootStored: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'SharedDmo',
        dataspaceName: '',
        dependsOn: [],
        entityPayload: { masterLabel: 'shared' },
      };
      await writeFixture(tmp, rootStored);

      // ... but requested with a dataspace context. Root-first lookup still finds it.
      const result = await readComponentFile('DataModelObject', 'SharedDmo', 'default', { baseDir: tmp });
      expect(result.componentName).to.equal('SharedDmo');
      expect(result.dataspaceName).to.equal('');
    });

    it('throws ComponentNotFoundError when the file does not exist', async () => {
      try {
        await readComponentFile('CalculatedInsight', 'nope', 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('ComponentNotFoundError');
        expect((error as Error).message).to.include('Run "sf data-cloud retrieve" first.');
      }
    });

    it('throws InvalidComponentFileError for malformed JSON', async () => {
      const path = join(tmp, 'data-cloud', 'default', 'calculated-insights', 'broken.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, '{ not valid json');
      try {
        await readComponentFile('CalculatedInsight', 'broken', 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('InvalidComponentFileError');
        expect((error as Error).message).to.include('invalid JSON');
      }
    });

    it('throws InvalidComponentFileError when a required field (entityPayload) is missing', async () => {
      const path = join(tmp, 'data-cloud', 'default', 'calculated-insights', 'partial.json');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        `${JSON.stringify(
          { componentType: 'CalculatedInsight', componentName: 'partial', dataspaceName: 'default', dependsOn: [] },
          null,
          2
        )}\n`
      );
      try {
        await readComponentFile('CalculatedInsight', 'partial', 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('InvalidComponentFileError');
        expect((error as Error).message).to.include('entityPayload');
      }
    });
  });

  describe('collectTransitiveDependencies', () => {
    it('collects root + a single direct dependency (CI → DMO leaf)', async () => {
      const ci: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'CI',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'Dmo', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      const dmo: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'Dmo',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: {},
      };
      await writeFixture(tmp, ci);
      await writeFixture(tmp, dmo);

      const result = await collectTransitiveDependencies([ci], 'default', { baseDir: tmp });
      expect(keysOf(result)).to.deep.equal(['CalculatedInsight:CI', 'DataModelObject:Dmo']);
      expect(result[0].componentName).to.equal('CI'); // root is pushed first (single-root determinism)
    });

    it('collects a multi-level chain (A → B → C)', async () => {
      const a: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'A',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'B', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      const b: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'B',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'C', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      const c: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'C',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: {},
      };
      await writeFixture(tmp, a);
      await writeFixture(tmp, b);
      await writeFixture(tmp, c);

      const result = await collectTransitiveDependencies([a], 'default', { baseDir: tmp });
      expect(keysOf(result)).to.deep.equal(['CalculatedInsight:A', 'DataModelObject:B', 'DataModelObject:C']);
    });

    it('deduplicates diamond dependencies (A → B, A → C, B → D, C → D ⇒ D once)', async () => {
      const a: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'A',
        dataspaceName: 'default',
        dependsOn: [
          { componentName: 'B', componentType: 'DataModelObject' },
          { componentName: 'C', componentType: 'DataModelObject' },
        ],
        entityPayload: {},
      };
      const b: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'B',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'D', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      const c: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'C',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'D', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      const d: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'D',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: {},
      };
      await writeFixture(tmp, a);
      await writeFixture(tmp, b);
      await writeFixture(tmp, c);
      await writeFixture(tmp, d);

      const result = await collectTransitiveDependencies([a], 'default', { baseDir: tmp });
      expect(result).to.have.lengthOf(4);
      expect(keysOf(result)).to.deep.equal([
        'CalculatedInsight:A',
        'DataModelObject:B',
        'DataModelObject:C',
        'DataModelObject:D',
      ]);
    });

    it("collects only the named component's deps, not unrelated components on disk", async () => {
      const ci: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'CI',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'Dmo', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      const dmo: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'Dmo',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: {},
      };
      const orphan: ComponentFile = {
        componentType: 'DataModelObject',
        componentName: 'Orphan',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: {},
      };
      await writeFixture(tmp, ci);
      await writeFixture(tmp, dmo);
      await writeFixture(tmp, orphan); // present on disk but unreachable from CI

      const result = await collectTransitiveDependencies([ci], 'default', { baseDir: tmp });
      expect(keysOf(result)).to.deep.equal(['CalculatedInsight:CI', 'DataModelObject:Dmo']);
    });

    it('resolves a DataLakeObject dependency from the root path', async () => {
      const transform: ComponentFile = {
        componentType: 'DataTransform',
        componentName: 'T',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'myDLO', componentType: 'DataLakeObject' }],
        entityPayload: '{}',
      };
      const dlo: ComponentFile = {
        componentType: 'DataLakeObject',
        componentName: 'myDLO',
        dataspaceName: 'default',
        dependsOn: [],
        entityPayload: '{}',
      };
      await writeFixture(tmp, transform); // dataspace-scoped
      await writeFixture(tmp, dlo); // root-level

      const result = await collectTransitiveDependencies([transform], 'default', { baseDir: tmp });
      expect(keysOf(result)).to.deep.equal(['DataLakeObject:myDLO', 'DataTransform:T']);
    });

    it('throws DependencyNotFoundError when a dep file is missing', async () => {
      const ci: ComponentFile = {
        componentType: 'CalculatedInsight',
        componentName: 'CI',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'Ghost', componentType: 'DataModelObject' }],
        entityPayload: {},
      };
      await writeFixture(tmp, ci); // dep "Ghost" never written

      try {
        await collectTransitiveDependencies([ci], 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('DependencyNotFoundError');
        expect((error as Error).message).to.include('referenced by "CalculatedInsight:CI"');
      }
    });
  });
});
