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
import { expect } from 'chai';
import { toKebabCase, pluralize, folderForComponentType } from '../../../src/shared/constants/component-paths.js';

describe('constants/component-paths', () => {
  describe('toKebabCase', () => {
    it('splits PascalCase into kebab-case', () => {
      expect(toKebabCase('CalculatedInsight')).to.equal('calculated-insight');
      expect(toKebabCase('DataModelObject')).to.equal('data-model-object');
    });

    it('splits acronym runs at the word boundary', () => {
      expect(toKebabCase('HTTPConnection')).to.equal('http-connection');
      expect(toKebabCase('DataAPIObject')).to.equal('data-api-object');
    });

    it('handles digit boundaries', () => {
      expect(toKebabCase('Data2Object')).to.equal('data-2-object');
    });

    it('is idempotent for spaces, snake_case, and existing kebab-case input', () => {
      expect(toKebabCase('Data Model Object')).to.equal('data-model-object');
      expect(toKebabCase('Data_Model_Object')).to.equal('data-model-object');
      expect(toKebabCase('data-model-object')).to.equal('data-model-object');
    });

    it('neutralizes path traversal and separators (cannot escape the tree)', () => {
      // Path separators / dots / colons carry no alphanumerics of their own, so they collapse to a
      // single hyphen or trim away — the result can never contain a separator or "..".
      expect(toKebabCase('../../etc/passwd')).to.equal('etc-passwd');
      expect(toKebabCase('..')).to.equal('');
      expect(toKebabCase('/')).to.equal('');
      expect(toKebabCase('a/b\\c:d')).to.equal('a-b-c-d');
      expect(toKebabCase('Type\u0000Name')).to.equal('type-name');
    });

    it('returns empty string for input with no alphanumeric content', () => {
      expect(toKebabCase('')).to.equal('');
      expect(toKebabCase('   ')).to.equal('');
      expect(toKebabCase('///')).to.equal('');
    });
  });

  describe('pluralize', () => {
    it('appends s to a regular last segment', () => {
      expect(pluralize('calculated-insight')).to.equal('calculated-insights');
      expect(pluralize('data-graph')).to.equal('data-graphs');
    });

    it('is idempotent when already plural', () => {
      expect(pluralize('data-streams')).to.equal('data-streams');
      expect(pluralize('segments')).to.equal('segments');
    });

    it('uses -es after sibilants and -ies after a consonant + y', () => {
      expect(pluralize('data-mesh')).to.equal('data-meshes');
      expect(pluralize('data-box')).to.equal('data-boxes');
      expect(pluralize('data-proxy')).to.equal('data-proxies');
    });

    it('only pluralizes the last hyphen segment', () => {
      expect(pluralize('data-model-object')).to.equal('data-model-objects');
    });
  });

  describe('folderForComponentType', () => {
    it('derives kebab-case plural folders for every current type consistently', () => {
      expect(folderForComponentType('CalculatedInsight')).to.equal('calculated-insights');
      expect(folderForComponentType('DataModelObject')).to.equal('data-model-objects');
      expect(folderForComponentType('DataTransform')).to.equal('data-transforms');
      expect(folderForComponentType('DataLakeObject')).to.equal('data-lake-objects');
      expect(folderForComponentType('IdentityResolution')).to.equal('identity-resolutions');
      expect(folderForComponentType('DataConnection')).to.equal('data-connections');
      expect(folderForComponentType('DataAction')).to.equal('data-actions');
      expect(folderForComponentType('DataGraph')).to.equal('data-graphs');
      // Formerly irregular overrides — now derived like everything else (folder names change).
      expect(folderForComponentType('MarketSegment')).to.equal('market-segments');
      expect(folderForComponentType('DataStreamBundle')).to.equal('data-stream-bundles');
    });

    it('derives a folder for a brand-new backend type with zero CLI changes', () => {
      expect(folderForComponentType('DataMesh')).to.equal('data-meshes');
    });

    it('throws a structured InvalidComponentTypeError for empty/blank/punctuation-only types', () => {
      expect(() => folderForComponentType('')).to.throw(/empty or invalid/);
      expect(() => folderForComponentType('   ')).to.throw(/empty or invalid/);
      expect(() => folderForComponentType('///')).to.throw(/empty or invalid/);
    });
  });
});
