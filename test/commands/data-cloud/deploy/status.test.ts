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
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import { Lifecycle } from '@salesforce/core';
import DataCloudDeployStatus from '../../../../src/commands/data-cloud/deploy/status.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  type TelemetryEvent,
} from '../../../shared/telemetry-test-utils.js';

describe('data-cloud deploy status', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let telemetry: TelemetryEvent[];

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    telemetry = [];
    captureTelemetry(telemetry);
  });

  afterEach(() => {
    resetTelemetry();
    $$.restore();
  });

  it('maps the SUCCESS backend payload to a SUCCEEDED human-readable status', async () => {
    const result = await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb', '--target-org', 'uat-org']);

    // The returned object keeps the raw contract value (§5.7); only the display is mapped.
    expect(result.status).to.equal('SUCCESS');
    expect(result.jobId).to.equal('08PVF000002iQIb');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Job ID: 08PVF000002iQIb');
    expect(output).to.include('Status: SUCCEEDED');
  });

  it('reports the failing component and reason on a FAILED job', async () => {
    const result = await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb-fail', '--target-org', 'uat-org']);

    expect(result.status).to.equal('FAILED');
    expect(result.components?.componentName).to.equal('HighValueCustomers');

    const output = sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');
    expect(output).to.include('Status: FAILED');
    expect(output).to.include("Error details for component 'HighValueCustomers':");
    expect(output).to.include(
      'Reason: Component validation failed: Calculated Insight expression contains an invalid syntax'
    );
  });

  it('fails if the required job-id flag is missing', async () => {
    try {
      await DataCloudDeployStatus.run(['--target-org', 'uat-org']);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.include('Missing required flag job-id');
    }
  });

  describe('telemetry', () => {
    it('emits a safe terminal-SUCCESS poll event (raw enum, not the SUCCEEDED display string)', async () => {
      await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb', '--target-org', 'uat-org']);

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.eventName).to.equal('DATACLOUD_DEVOPS_DEPLOY_STATUS_POLL');
      expect(e.surface).to.equal('cli');
      expect(e.lifecycleStatus).to.equal('SUCCESS'); // raw contract enum, NOT 'SUCCEEDED'
      expect(e.isTerminal).to.equal(true);
      expect(e.success).to.equal(true);
      expect(e.hadComponentError).to.equal(false);
      expect(e.usedJson).to.be.a('boolean');
      assertAllSafe(telemetry);
    });

    it('emits a FAILED poll event without leaking the failing component name or error message', async () => {
      await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb-fail', '--target-org', 'uat-org']);

      const e = ourEvents(telemetry)[0];
      expect(e.lifecycleStatus).to.equal('FAILED');
      expect(e.isTerminal).to.equal(true);
      expect(e.success).to.equal(false);
      expect(e.hadComponentError).to.equal(true); // presence only
      // The mock's componentName ('HighValueCustomers') and error message must never ship.
      expect(JSON.stringify(e)).to.not.match(/HighValueCustomers|invalid syntax|line 4/);
      assertAllSafe(telemetry);
    });

    it('never lets a throwing telemetry listener break the command', async () => {
      Lifecycle.getInstance().onTelemetry(() => {
        throw new Error('telemetry boom');
      });
      const result = await DataCloudDeployStatus.run(['--job-id', '08PVF000002iQIb', '--target-org', 'uat-org']);
      expect(result.status).to.equal('SUCCESS');

      const output = sfCommandStubs.log
        .getCalls()
        .flatMap((c) => c.args)
        .join('\n');
      expect(output).to.include('Status: SUCCEEDED'); // user-facing logging is unaffected
    });
  });
});
