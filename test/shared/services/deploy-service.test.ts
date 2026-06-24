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
import { Connection, Lifecycle } from '@salesforce/core';
import {
  parseComponentFlag,
  assembleDeployRequest,
  deployComponents,
} from '../../../src/shared/services/deploy-service.js';
import { writeRetrievedComponents } from '../../../src/shared/services/file-writer.js';
import { getMockRetrieveApiResponse } from '../../../src/shared/mocks/retrieve-api-response.mock.js';
import { ComponentFile } from '../../../src/shared/types/file-layout.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  UUID_RE,
  type TelemetryEvent,
} from '../../shared/telemetry-test-utils.js';

/** Tracking jobId the backend returns alongside the SUBMITTED submission ack. */
const JOB_ID = '08PVF000002iQIb';

/**
 * Stand-in Connection for the deploy POST: resolves to the submission ack ({ status, jobId }), or
 * rejects with `reject` to exercise the API-error path. The deploy service never inspects the
 * connection beyond handing it to createPromotion, so a minimal stub suffices.
 */
const fakeConn = (opts: { reject?: unknown } = {}): Connection =>
  ({
    getApiVersion: () => '62.0',
    request: () =>
      opts.reject ? Promise.reject(opts.reject) : Promise.resolve({ status: 'SUBMITTED', jobId: JOB_ID }),
  } as unknown as Connection);

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

    it('splits on the first colon, preserving colons in the name (matches source-deploy-retrieve)', () => {
      expect(parseComponentFlag('CalculatedInsight:weird:name')).to.deep.equal({
        componentType: 'CalculatedInsight',
        componentName: 'weird:name',
      });
    });
  });

  describe('assembleDeployRequest', () => {
    it('produces a bare array of components keyed by entityPayload, dataspaceName per-component', () => {
      const components: ComponentFile[] = [
        {
          componentType: 'CalculatedInsight',
          componentName: 'CI',
          dataspaceName: 'default',
          dependsOn: [{ componentName: 'Dmo', componentType: 'DataModelObject' }],
          entityPayload: { masterLabel: 'testCI' },
        },
      ];
      const request = assembleDeployRequest(components);

      // The request is a bare array — no wrapper object, no top-level dataSpaceName.
      expect(request).to.be.an('array').with.lengthOf(1);
      expect(request).to.not.have.property('dataSpaceName');
      expect(request[0]).to.deep.equal({
        componentType: 'CalculatedInsight',
        componentName: 'CI',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'Dmo', componentType: 'DataModelObject' }],
        entityPayload: { masterLabel: 'testCI' },
      });
      // Payload key is `entityPayload`, never `data`.
      expect(request[0]).to.not.have.property('data');
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
      const request = assembleDeployRequest(components);
      expect(request[0].entityPayload).to.equal('{ "label": "My Transform", "type": "BATCH" }');
      expect(request[0].entityPayload).to.be.a('string');
    });
  });

  describe('deployComponents', () => {
    let tmp: string;
    let telemetry: TelemetryEvent[];

    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), 'dc-deploy-svc-'));
      const { components } = getMockRetrieveApiResponse('default');
      await writeRetrievedComponents(components, { baseDir: tmp });
      telemetry = [];
      captureTelemetry(telemetry);
    });

    afterEach(() => {
      resetTelemetry();
      rmSync(tmp, { recursive: true, force: true });
    });

    it('deploys a component + its transitive deps and returns the SUBMITTED ack with its jobId', async () => {
      const result = await deployComponents(fakeConn(), 'CalculatedInsight:highValueCustomer', 'default', {
        baseDir: tmp,
      });
      expect(result.status).to.equal('SUBMITTED');
      expect(result.jobId).to.equal(JOB_ID);
    });

    it('resolves a DataLakeObject dependency from the root path (Transform → DLO → DMO)', async () => {
      // Exercises the full chain: read transform (dataspace-scoped) → walk to DLO (root) + DMO.
      const result = await deployComponents(fakeConn(), 'DataTransform:myTransform', 'default', { baseDir: tmp });
      expect(result.status).to.equal('SUBMITTED');
    });

    it('throws ComponentNotFoundError when the named component is missing', async () => {
      try {
        await deployComponents(fakeConn(), 'CalculatedInsight:doesNotExist', 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('ComponentNotFoundError');
      }
    });

    it('surfaces a mapped API error (and emits a failure event) when the deploy POST rejects', async () => {
      const conn = fakeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await deployComponents(conn, 'CalculatedInsight:highValueCustomer', 'default', { baseDir: tmp });
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as Error).name).to.equal('DataCloudApiAuthError');
      }

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.success).to.equal(false);
      expect(e.errorCode).to.equal('DataCloudApiAuthError');
      expect(Object.keys(e)).to.not.include('message');
      expect(JSON.stringify(e)).to.not.match(/Session expired/);
      assertAllSafe(telemetry);
    });

    describe('telemetry', () => {
      it('emits exactly one safe DEPLOY_COMPONENT success event with graph size and SUBMITTED status', async () => {
        await deployComponents(fakeConn(), 'CalculatedInsight:highValueCustomer', 'default', { baseDir: tmp });

        const events = ourEvents(telemetry);
        expect(events).to.have.lengthOf(1);
        const e = events[0];
        expect(e.eventName).to.equal('DATACLOUD_DEVOPS_DEPLOY_COMPONENT');
        expect(e.surface).to.equal('cli');
        expect(e.correlationId).to.match(UUID_RE); // client-generated CLI-side trace id (backend live)
        expect(e.componentType).to.equal('CalculatedInsight');
        expect(e.success).to.equal(true);
        expect(e.componentCount).to.equal(2); // CI + its one DMO dependency
        expect(e.dependencyCount).to.equal(1);
        expect(e.hadDependencies).to.equal(true);
        expect(e.lifecycleStatus).to.equal('SUBMITTED');
        expect(Number.isInteger(e.durationMs)).to.equal(true);
        expect(e.durationMs as number).to.be.at.least(0);
        assertAllSafe(telemetry);
      });

      it('emits a single failure event with errorCode (never the message) and re-throws unchanged', async () => {
        try {
          await deployComponents(fakeConn(), 'CalculatedInsight:doesNotExist', 'default', { baseDir: tmp });
          expect.fail('Should have thrown');
        } catch (error) {
          expect((error as Error).name).to.equal('ComponentNotFoundError'); // original error preserved
        }

        const events = ourEvents(telemetry);
        expect(events).to.have.lengthOf(1);
        const e = events[0];
        expect(e.success).to.equal(false);
        expect(e.errorCode).to.equal('ComponentNotFoundError');
        expect(Object.keys(e)).to.not.include('message');
        assertAllSafe(telemetry);
      });

      it('never lets a throwing telemetry listener break the deploy', async () => {
        Lifecycle.getInstance().onTelemetry(() => {
          throw new Error('telemetry boom');
        });
        const result = await deployComponents(fakeConn(), 'CalculatedInsight:highValueCustomer', 'default', {
          baseDir: tmp,
        });
        expect(result.status).to.equal('SUBMITTED');
      });
    });
  });
});
