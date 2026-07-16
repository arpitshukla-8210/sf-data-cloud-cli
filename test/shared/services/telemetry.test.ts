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
import { safeComponentType } from '../../../src/shared/services/telemetry.js';

describe('telemetry/safeComponentType', () => {
  it('passes a well-formed PascalCase type through unchanged', () => {
    expect(safeComponentType('CalculatedInsight')).to.equal('CalculatedInsight');
    expect(safeComponentType('DataModelObject')).to.equal('DataModelObject');
  });

  it('passes a brand-new backend type through as itself (allowlist no longer required)', () => {
    // The whole point of decoupling: a type the CLI has never heard of is reported faithfully, not
    // flattened to "other", as long as it is a bounded, separator-free identifier.
    expect(safeComponentType('DataMesh')).to.equal('DataMesh');
    expect(safeComponentType('SomeFutureType2')).to.equal('SomeFutureType2');
  });

  it('bounds a path-shaped value to "other" so a path can never leak', () => {
    expect(safeComponentType('/Users/me/secret')).to.equal('other');
    expect(safeComponentType('..\\Windows\\secret')).to.equal('other');
  });

  it('bounds an email-shaped or otherwise structured value to "other"', () => {
    expect(safeComponentType('acct@corp.com')).to.equal('other');
    expect(safeComponentType('Type:Name')).to.equal('other');
    expect(safeComponentType('has space')).to.equal('other');
    expect(safeComponentType('kebab-case')).to.equal('other');
  });

  it('bounds empty, blank, and pathologically long values to "other"', () => {
    expect(safeComponentType('')).to.equal('other');
    expect(safeComponentType('   ')).to.equal('other');
    expect(safeComponentType('A'.repeat(65))).to.equal('other');
  });
});
