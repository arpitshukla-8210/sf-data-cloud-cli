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
import { Connection, Lifecycle } from '@salesforce/core';
import { retrieveComponents } from '../../../src/shared/services/retrieve-service.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  UUID_RE,
  type TelemetryEvent,
} from '../../shared/telemetry-test-utils.js';

/*
 * Inject a stand-in Connection whose `request` returns the existing snapshot mock. The service is
 * exercised end-to-end (parse flag -> devops-api.getSnapshot -> file-writer) without a real org; the
 * mock is keyed on the requested dataspace so non-default cases still echo correctly.
 */
const fakeConn = (dataspace: string, orgId?: string): Connection =>
  ({
    getApiVersion: () => '62.0',
    // Mirrors the real accessor safeOrgId reads; orgId is undefined unless a test supplies one.
    getAuthInfoFields: () => ({ orgId }),
    request: () => Promise.resolve(getMockRetrieveApiResponse(dataspace)),
  } as unknown as Connection);

describe('retrieve-service', () => {
  let tmp: string;
  let telemetry: TelemetryEvent[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dc-svc-'));
    telemetry = [];
    captureTelemetry(telemetry);
  });

  afterEach(() => {
    resetTelemetry();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the standardized result and writes the data-cloud tree to baseDir', async () => {
    const result = await retrieveComponents(fakeConn('default'), 'CalculatedInsight:highValueCustomer', 'default', {
      baseDir: tmp,
    });

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

  it('routes every component to the data-cloud/ root when no dataspace is given', async () => {
    // The mock keys dataspaceName off its argument; '' yields components with an empty dataspace,
    // which the file-writer routes to the root (§5.2). The service is called with no dataspace arg.
    const result = await retrieveComponents(fakeConn(''), 'CalculatedInsight:highValueCustomer', undefined, {
      baseDir: tmp,
    });

    expect(result.dataspace).to.equal('');
    expect(result.fileWriteLocation).to.equal('./data-cloud/');
    expect(result.retrievedComponents.every((c) => c.dataspaceName === '')).to.equal(true);

    // CI (a dataspace-scoped type) lands at the root since it carries no dataspace.
    expect(existsSync(join(tmp, 'data-cloud', 'calculated-insights', 'highValueCustomer.json'))).to.equal(true);
    // No dataspace subdirectory was created.
    expect(existsSync(join(tmp, 'data-cloud', 'default'))).to.equal(false);
    expect(existsSync(join(tmp, 'data-cloud', 'manifest.json'))).to.equal(true);
  });

  it('echoes a non-default dataspace into the result and the write paths', async () => {
    const result = await retrieveComponents(
      fakeConn('analytics_ds'),
      'CalculatedInsight:highValueCustomer',
      'analytics_ds',
      { baseDir: tmp }
    );

    expect(result.dataspace).to.equal('analytics_ds');
    expect(result.fileWriteLocation).to.equal('./data-cloud/analytics_ds/');
    expect(result.retrievedComponents.every((c) => c.dataspaceName === 'analytics_ds')).to.equal(true);
    expect(
      existsSync(join(tmp, 'data-cloud', 'analytics_ds', 'calculated-insights', 'highValueCustomer.json'))
    ).to.equal(true);
  });

  it('rejects a --component that is not in TYPE:NAME form', async () => {
    try {
      await retrieveComponents(fakeConn('default'), 'highValueCustomer', 'default', { baseDir: tmp });
      expect.fail('expected retrieveComponents to throw for a malformed component flag');
    } catch (err) {
      expect((err as Error & { code?: string }).name).to.equal('InvalidComponentFlagError');
    }
  });

  describe('telemetry', () => {
    it('emits exactly one safe RETRIEVE_COMPONENT success event with graph size and duration', async () => {
      await retrieveComponents(
        fakeConn('default', '00DXX0000000000AAA'),
        'CalculatedInsight:highValueCustomer',
        'default',
        { baseDir: tmp }
      );

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.eventName).to.equal('DATACLOUD_DEVOPS_RETRIEVE_COMPONENT');
      expect(e.surface).to.equal('cli');
      expect(e.correlationId).to.match(UUID_RE); // CLI-side trace id for the retrieve operation
      expect(e.orgId).to.equal('00DXX0000000000AAA'); // customer-org correlation
      expect(e.componentType).to.equal('CalculatedInsight'); // a TYPE, never the name
      expect(e.success).to.equal(true);
      expect(Number.isInteger(e.componentCount)).to.equal(true);
      expect(e.componentCount).to.equal(5);
      expect(Number.isInteger(e.dependencyCount)).to.equal(true);
      expect(e.dependencyCount).to.equal(4);
      expect(e.hadDependencies).to.equal(true);
      expect(Number.isInteger(e.durationMs)).to.equal(true);
      expect(e.durationMs as number).to.be.at.least(0);
      assertAllSafe(telemetry);
    });

    it('bounds an unknown/free-text component type to "other" so a path can never leak', async () => {
      // A path-shaped type before the colon must NOT reach telemetry verbatim.
      const malformed = '/Users/me/secret:Foo';
      // getSnapshot will 404 on the fake conn? No — fakeConn ignores args and returns the mock, so
      // this resolves successfully; the point is purely that the emitted componentType is bounded.
      await retrieveComponents(fakeConn('default'), malformed, 'default', { baseDir: tmp });

      const e = ourEvents(telemetry)[0];
      expect(e.componentType).to.equal('other');
      assertAllSafe(telemetry);
    });

    it('emits a single failure event with errorCode + errorMessage (never under `message`) and re-throws unchanged', async () => {
      try {
        await retrieveComponents(fakeConn('default', '00DXX0000000000AAA'), 'highValueCustomer', 'default', {
          baseDir: tmp,
        });
        expect.fail('expected a throw for the malformed flag');
      } catch (err) {
        expect((err as Error).name).to.equal('InvalidComponentFlagError'); // original error preserved
      }

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.correlationId).to.match(UUID_RE); // present even when the parse fails early
      expect(e.orgId).to.equal('00DXX0000000000AAA'); // customer-org correlation, even on the error path
      expect(e.success).to.equal(false);
      expect(e.errorCode).to.equal('InvalidComponentFlagError');
      expect(e.componentType).to.equal('unknown'); // parse threw before a type was known
      // The full error text rides under `errorMessage`; the raw key `message` is never used.
      expect(Object.keys(e)).to.not.include('message');
      expect(e.errorMessage).to.be.a('string').and.to.include('Expected TYPE:NAME');
      expect(Object.keys(e)).to.not.include('gackId'); // extraction disabled
      assertAllSafe(telemetry);
    });

    it('never lets a throwing telemetry listener break the retrieve', async () => {
      Lifecycle.getInstance().onTelemetry(() => {
        throw new Error('telemetry boom');
      });
      const result = await retrieveComponents(fakeConn('default'), 'CalculatedInsight:highValueCustomer', 'default', {
        baseDir: tmp,
      });
      expect(result.retrievedComponents).to.have.lengthOf(5);
      expect(result.fileWriteLocation).to.equal('./data-cloud/default/');
    });
  });
});
