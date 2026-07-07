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
import { getPluginVersion, resetPluginVersionForTest } from '../../../src/shared/diagnostics/plugin-version.js';

describe('diagnostics/plugin-version', () => {
  afterEach(() => resetPluginVersionForTest());

  it('reads the real package.json version (a semver-ish, non-unknown string)', () => {
    const version = getPluginVersion();
    expect(version).to.be.a('string');
    expect(version).to.not.equal('unknown');
    expect(version).to.match(/^\d+\.\d+\.\d+/);
  });

  it('memoizes: repeated calls return the same value', () => {
    expect(getPluginVersion()).to.equal(getPluginVersion());
  });
});
