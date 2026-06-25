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
import { Connection, Lifecycle } from '@salesforce/core';
import {
  checkDeployStatus,
  toLifecycleStatus,
  toComponentStatus,
  deriveDeployErrorCode,
} from '../../../src/shared/services/deploy-status-service.js';
import { DeployStatusApiResponse } from '../../../src/shared/types/deploy-status.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  UUID_RE,
  type TelemetryEvent,
} from '../../shared/telemetry-test-utils.js';

const JOB_ID = '08PVF000002iQIb';

/**
 * Stand-in Connection for the status GET: resolves to `response` (the raw PascalCase wire body), or
 * rejects with `reject` to exercise the API-error path. The service never inspects the connection
 * beyond handing it to getPromotionStatus, so a minimal stub suffices.
 */
const fakeConn = (opts: { response?: DeployStatusApiResponse; reject?: unknown }): Connection =>
  ({
    getApiVersion: () => '62.0',
    request: () => (opts.reject ? Promise.reject(opts.reject) : Promise.resolve(opts.response)),
  } as unknown as Connection);

describe('deploy-status-service', () => {
  describe('toLifecycleStatus', () => {
    it('maps each PascalCase job status to its UPPERCASE CLI value', () => {
      expect(toLifecycleStatus('Success')).to.equal('SUCCESS');
      expect(toLifecycleStatus('Failed')).to.equal('FAILED');
      expect(toLifecycleStatus('InProgress')).to.equal('INPROGRESS');
      expect(toLifecycleStatus('Created')).to.equal('CREATED');
    });

    it('folds an unknown/unexpected value to INPROGRESS (never a false terminal state)', () => {
      expect(toLifecycleStatus('Pending')).to.equal('INPROGRESS');
      expect(toLifecycleStatus('something-else')).to.equal('INPROGRESS');
    });
  });

  describe('toComponentStatus', () => {
    it('maps Success and Failed; folds InProgress/Pending/unknown to INPROGRESS', () => {
      expect(toComponentStatus('Success')).to.equal('SUCCESS');
      expect(toComponentStatus('Failed')).to.equal('FAILED');
      expect(toComponentStatus('InProgress')).to.equal('INPROGRESS');
      expect(toComponentStatus('Pending')).to.equal('INPROGRESS');
      expect(toComponentStatus('weird')).to.equal('INPROGRESS');
    });
  });

  describe('deriveDeployErrorCode', () => {
    it('returns ComponentValidationError when any component FAILED', () => {
      expect(
        deriveDeployErrorCode([
          { componentName: 'a', componentType: 'CalculatedInsight', status: 'SUCCESS' },
          { componentName: 'b', componentType: 'DataModelObject', status: 'FAILED', error: 'boom' },
        ])
      ).to.equal('ComponentValidationError');
    });

    it('returns DeployJobFailed when no component FAILED (job-level failure)', () => {
      expect(
        deriveDeployErrorCode([{ componentName: 'a', componentType: 'CalculatedInsight', status: 'SUCCESS' }])
      ).to.equal('DeployJobFailed');
      expect(deriveDeployErrorCode([])).to.equal('DeployJobFailed');
    });
  });

  describe('checkDeployStatus', () => {
    let telemetry: TelemetryEvent[];

    beforeEach(() => {
      telemetry = [];
      captureTelemetry(telemetry);
    });

    afterEach(() => {
      resetTelemetry();
    });

    it('normalizes the PascalCase job + per-component statuses to UPPERCASE and passes the array through', async () => {
      const conn = fakeConn({
        response: {
          jobId: JOB_ID,
          status: 'InProgress',
          components: [
            { componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Success' },
            { componentName: 'MyDmo', componentType: 'DataModelObject', status: 'InProgress' },
          ],
        },
      });
      const result = await checkDeployStatus(conn, JOB_ID);

      expect(result.jobId).to.equal(JOB_ID);
      expect(result.status).to.equal('INPROGRESS');
      expect(result.components).to.deep.equal([
        { componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'SUCCESS' },
        { componentName: 'MyDmo', componentType: 'DataModelObject', status: 'INPROGRESS' },
      ]);
    });

    it('carries the error only on a failed component (omitted when the backend sends none)', async () => {
      const conn = fakeConn({
        response: {
          jobId: JOB_ID,
          status: 'Failed',
          components: [
            { componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Failed', error: 'bad expression' },
            { componentName: 'MyDmo', componentType: 'DataModelObject', status: 'Success' },
          ],
        },
      });
      const result = await checkDeployStatus(conn, JOB_ID);

      const failed = result.components.find((c) => c.status === 'FAILED');
      const ok = result.components.find((c) => c.status === 'SUCCESS');
      expect(failed?.error).to.equal('bad expression');
      expect(Object.keys(ok!)).to.not.include('error');
    });

    it('returns an empty components array unchanged (e.g. a CREATED job with no rows yet)', async () => {
      const conn = fakeConn({ response: { jobId: JOB_ID, status: 'Created', components: [] } });
      const result = await checkDeployStatus(conn, JOB_ID);
      expect(result.status).to.equal('CREATED');
      expect(result.components).to.deep.equal([]);
    });

    it('emits one safe SUCCESS poll event (correlationId, componentCount, no errorCode)', async () => {
      const conn = fakeConn({
        response: {
          jobId: JOB_ID,
          status: 'Success',
          components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Success' }],
        },
      });
      await checkDeployStatus(conn, JOB_ID);

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.eventName).to.equal('DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL');
      expect(e.surface).to.equal('cli');
      expect(e.correlationId).to.match(UUID_RE);
      expect(e.lifecycleStatus).to.equal('SUCCESS');
      expect(e.isTerminal).to.equal(true);
      expect(e.success).to.equal(true);
      expect(e.componentCount).to.equal(1);
      expect(e.hadComponentError).to.equal(false);
      expect(Number.isInteger(e.durationMs)).to.equal(true);
      expect(Object.keys(e)).to.not.include('errorCode');
      assertAllSafe(telemetry);
    });

    it('emits errorCode=ComponentValidationError on a FAILED job with a failed component, leaking nothing', async () => {
      const conn = fakeConn({
        response: {
          jobId: JOB_ID,
          status: 'Failed',
          components: [
            { componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Failed', error: 'bad expression' },
          ],
        },
      });
      await checkDeployStatus(conn, JOB_ID);

      const e = ourEvents(telemetry)[0];
      expect(e.lifecycleStatus).to.equal('FAILED');
      expect(e.success).to.equal(false);
      expect(e.hadComponentError).to.equal(true);
      expect(e.errorCode).to.equal('ComponentValidationError');
      // No component name or error message may ship.
      expect(JSON.stringify(e)).to.not.match(/MyCi|bad expression/);
      assertAllSafe(telemetry);
    });

    it('emits errorCode=DeployJobFailed on a FAILED job with no failed component', async () => {
      const conn = fakeConn({
        response: {
          jobId: JOB_ID,
          status: 'Failed',
          components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Success' }],
        },
      });
      await checkDeployStatus(conn, JOB_ID);

      const e = ourEvents(telemetry)[0];
      expect(e.errorCode).to.equal('DeployJobFailed');
      expect(e.hadComponentError).to.equal(false);
    });

    it('emits a single failure event with the mapped errorCode and re-throws the ORIGINAL error', async () => {
      const conn = fakeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await checkDeployStatus(conn, JOB_ID);
        expect.fail('Should have thrown');
      } catch (error) {
        // The original mapped SfError from devops-api is preserved (not re-wrapped).
        expect((error as Error).name).to.equal('DataCloudApiAuthError');
      }

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.correlationId).to.match(UUID_RE);
      expect(e.success).to.equal(false);
      expect(e.errorCode).to.equal('DataCloudApiAuthError');
      expect(Object.keys(e)).to.not.include('message');
      expect(JSON.stringify(e)).to.not.match(/Session expired/);
      assertAllSafe(telemetry);
    });

    it('never lets a throwing telemetry listener break the poll', async () => {
      Lifecycle.getInstance().onTelemetry(() => {
        throw new Error('telemetry boom');
      });
      const conn = fakeConn({ response: { jobId: JOB_ID, status: 'Success', components: [] } });
      const result = await checkDeployStatus(conn, JOB_ID);
      expect(result.status).to.equal('SUCCESS');
    });
  });
});
