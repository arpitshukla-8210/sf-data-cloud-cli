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
import { TestContext, MockTestOrgData } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { Lifecycle } from '@salesforce/core';
import { AnyJson } from '@salesforce/ts-types';
import DataCloudDeployStatus from '../../../../src/commands/data-cloud/deploy/status.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  UUID_RE,
  type TelemetryEvent,
} from '../../../shared/telemetry-test-utils.js';

const JOB_ID = '08PVF000002iQIb';

describe('data-cloud deploy status', () => {
  const $$ = new TestContext();
  const testOrg = new MockTestOrgData();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let telemetry: TelemetryEvent[];

  beforeEach(async () => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    await $$.stubAuths(testOrg);
    telemetry = [];
    captureTelemetry(telemetry);
  });

  afterEach(() => {
    resetTelemetry();
    $$.restore();
  });

  /** Fakes the GET /component/promotion/{jobId} response at the HTTP boundary (PascalCase wire enums). */
  const stubStatusResponse = (body: AnyJson): void => {
    $$.fakeConnectionRequest = (): Promise<AnyJson> => Promise.resolve(body);
  };

  /** Joins every line the command logged into one string for substring assertions. */
  const loggedOutput = (): string =>
    sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  it('maps a SUCCESS backend payload to a SUCCEEDED human-readable status and renders the table', async () => {
    stubStatusResponse({
      jobId: JOB_ID,
      status: 'Success',
      components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Success' }],
    } as unknown as AnyJson);

    const result = await DataCloudDeployStatus.run(['--job-id', JOB_ID, '--target-org', testOrg.username]);

    // The returned object keeps the raw UPPERCASE contract value (§5.7); only the display is mapped.
    expect(result.status).to.equal('SUCCESS');
    expect(result.jobId).to.equal(JOB_ID);
    expect(result.components).to.have.lengthOf(1);
    expect(result.components[0]).to.deep.equal({
      componentName: 'MyCi',
      componentType: 'CalculatedInsight',
      status: 'SUCCESS',
    });

    const output = loggedOutput();
    expect(output).to.include(`Job ID: ${JOB_ID}`);
    expect(output).to.include('Status: SUCCEEDED');
    // The per-component table is rendered exactly once.
    expect(sfCommandStubs.table.callCount).to.equal(1);
  });

  it('reports each failing component and its reason on a FAILED job', async () => {
    stubStatusResponse({
      jobId: JOB_ID,
      status: 'Failed',
      components: [
        {
          componentName: 'MyCi',
          componentType: 'CalculatedInsight',
          status: 'Failed',
          error: 'Expression invalid at line 4.',
        },
        { componentName: 'MyDmo', componentType: 'DataModelObject', status: 'Success' },
      ],
    } as unknown as AnyJson);

    const result = await DataCloudDeployStatus.run(['--job-id', JOB_ID, '--target-org', testOrg.username]);

    expect(result.status).to.equal('FAILED');
    expect(result.components).to.have.lengthOf(2);
    const failed = result.components.find((c) => c.status === 'FAILED');
    expect(failed?.componentName).to.equal('MyCi');
    expect(failed?.error).to.equal('Expression invalid at line 4.');

    const output = loggedOutput();
    expect(output).to.include('Status: FAILED');
    expect(output).to.include("Error details for component 'MyCi':");
    expect(output).to.include('Reason: Expression invalid at line 4.');
    expect(sfCommandStubs.table.callCount).to.equal(1);
  });

  it('reports INPROGRESS without a per-component error block', async () => {
    stubStatusResponse({
      jobId: JOB_ID,
      status: 'InProgress',
      components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'InProgress' }],
    } as unknown as AnyJson);

    const result = await DataCloudDeployStatus.run(['--job-id', JOB_ID, '--target-org', testOrg.username]);

    expect(result.status).to.equal('INPROGRESS');
    const output = loggedOutput();
    expect(output).to.include('Status: INPROGRESS');
    expect(output).to.not.include('Error details for component');
  });

  it('fails if the required job-id flag is missing', async () => {
    try {
      await DataCloudDeployStatus.run(['--target-org', testOrg.username]);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Missing required flag job-id');
    }
  });

  it('fails if the required target-org flag is missing and no default org is configured', async () => {
    try {
      await DataCloudDeployStatus.run(['--job-id', JOB_ID]);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/org|target-org|default environment/i);
    }
  });

  describe('telemetry', () => {
    it('emits a safe terminal-SUCCESS poll event (raw enum, real correlationId and componentCount)', async () => {
      stubStatusResponse({
        jobId: JOB_ID,
        status: 'Success',
        components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Success' }],
      } as unknown as AnyJson);

      await DataCloudDeployStatus.run(['--job-id', JOB_ID, '--target-org', testOrg.username]);

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.eventName).to.equal('DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL');
      expect(e.surface).to.equal('cli');
      expect(e.correlationId).to.match(UUID_RE); // client-generated CLI-side trace id (backend live)
      expect(e.lifecycleStatus).to.equal('SUCCESS'); // raw contract enum, NOT 'SUCCEEDED'
      expect(e.isTerminal).to.equal(true);
      expect(e.success).to.equal(true);
      expect(e.componentCount).to.be.a('number');
      expect(e.componentCount).to.equal(1);
      expect(e.hadComponentError).to.equal(false);
      expect(Number.isInteger(e.durationMs)).to.equal(true);
      expect(Object.keys(e)).to.not.include('errorCode'); // no errorCode on a successful poll
      assertAllSafe(telemetry);
    });

    it('emits a FAILED poll event without leaking the failing component name or error message', async () => {
      stubStatusResponse({
        jobId: JOB_ID,
        status: 'Failed',
        components: [
          {
            componentName: 'MyCi',
            componentType: 'CalculatedInsight',
            status: 'Failed',
            error: 'Expression invalid at line 4.',
          },
        ],
      } as unknown as AnyJson);

      await DataCloudDeployStatus.run(['--job-id', JOB_ID, '--target-org', testOrg.username]);

      const e = ourEvents(telemetry)[0];
      expect(e.correlationId).to.match(UUID_RE);
      expect(e.lifecycleStatus).to.equal('FAILED');
      expect(e.isTerminal).to.equal(true);
      expect(e.success).to.equal(false);
      expect(e.hadComponentError).to.equal(true); // presence only
      // Machine-parseable classification for agent/CI consumers — the code, never the name/message.
      expect(e.errorCode).to.equal('ComponentValidationError');
      // The component name ('MyCi') and the error message must never ship.
      expect(JSON.stringify(e)).to.not.match(/MyCi|Expression invalid|line 4/);
      assertAllSafe(telemetry);
    });

    it('never lets a throwing telemetry listener break the command', async () => {
      Lifecycle.getInstance().onTelemetry(() => {
        throw new Error('telemetry boom');
      });
      stubStatusResponse({
        jobId: JOB_ID,
        status: 'Success',
        components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'Success' }],
      } as unknown as AnyJson);

      const result = await DataCloudDeployStatus.run(['--job-id', JOB_ID, '--target-org', testOrg.username]);
      expect(result.status).to.equal('SUCCESS');
      expect(loggedOutput()).to.include('Status: SUCCEEDED'); // user-facing logging is unaffected
    });
  });
});
