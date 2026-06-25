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
import { Connection, SfError, Lifecycle } from '@salesforce/core';
import {
  getComponentTypes,
  getComponents,
  getSnapshot,
  createPromotion,
  getPromotionStatus,
} from '../../../src/shared/services/devops-api.js';
import { DeployApiRequest } from '../../../src/shared/types/deploy.js';
import {
  captureTelemetry,
  resetTelemetry,
  ourEvents,
  assertAllSafe,
  UUID_RE,
  type TelemetryEvent,
} from '../../shared/telemetry-test-utils.js';

/** A recorded request: a bare URL string (GET) or the HttpRequest object passed for a POST. */
type RecordedRequest = string | { method?: string; url?: string; body?: unknown; headers?: Record<string, string> };

/**
 * Builds a stand-in Connection: `request` records what it was called with — a URL string for GETs
 * or the full HttpRequest object for POSTs — and resolves to `response`, or rejects with `reject`
 * when provided (to exercise the error-mapping branches).
 */
const makeConn = (opts: { response?: unknown; reject?: unknown }): { conn: Connection; calls: RecordedRequest[] } => {
  const calls: RecordedRequest[] = [];
  const conn = {
    getApiVersion: () => '62.0',
    request: (request: RecordedRequest) => {
      calls.push(request);
      return opts.reject ? Promise.reject(opts.reject) : Promise.resolve(opts.response);
    },
  } as unknown as Connection;
  return { conn, calls };
};

describe('devops-api', () => {
  describe('request construction', () => {
    it('builds the versioned component-types path', async () => {
      const { conn, calls } = makeConn({ response: { supportedComponentTypes: {} } });
      await getComponentTypes(conn);
      expect(calls[0]).to.equal('/services/data/v62.0/ssot/devops/component-types');
    });

    it('builds the catalog path with URL-encoded query params', async () => {
      const { conn, calls } = makeConn({ response: { components: [] } });
      await getComponents(conn, 'CalculatedInsight', 'my space');
      expect(calls[0]).to.equal(
        '/services/data/v62.0/ssot/devops/component/catalog?componentType=CalculatedInsight&dataSpaceName=my+space'
      );
    });

    it('builds the snapshot path with all three query params', async () => {
      const { conn, calls } = makeConn({ response: { components: [] } });
      await getSnapshot(conn, 'CalculatedInsight', 'highValueCustomer', 'default');
      expect(calls[0]).to.equal(
        '/services/data/v62.0/ssot/devops/component/snapshot' +
          '?componentType=CalculatedInsight&componentName=highValueCustomer&dataSpaceName=default'
      );
    });

    it('omits dataSpaceName from the catalog path when no dataspace is given', async () => {
      const { conn, calls } = makeConn({ response: { components: [] } });
      await getComponents(conn, 'CalculatedInsight');
      expect(calls[0]).to.equal('/services/data/v62.0/ssot/devops/component/catalog?componentType=CalculatedInsight');
      expect(calls[0]).to.not.match(/dataSpaceName/);
    });

    it('omits dataSpaceName from the snapshot path when no dataspace is given', async () => {
      const { conn, calls } = makeConn({ response: { components: [] } });
      await getSnapshot(conn, 'CalculatedInsight', 'highValueCustomer');
      expect(calls[0]).to.equal(
        '/services/data/v62.0/ssot/devops/component/snapshot?componentType=CalculatedInsight&componentName=highValueCustomer'
      );
      expect(calls[0]).to.not.match(/dataSpaceName/);
    });

    it('returns the parsed response body verbatim', async () => {
      const body = { supportedComponentTypes: { CalculatedInsight: 'Calculated Insight' } };
      const { conn } = makeConn({ response: body });
      expect(await getComponentTypes(conn)).to.deep.equal(body);
    });
  });

  describe('createPromotion (deploy POST)', () => {
    // The request body wraps a `components` array — each element with its payload under
    // `entityPayload` and `dataspaceName` per-component.
    const sampleRequest: DeployApiRequest = [
      {
        componentType: 'CalculatedInsight',
        componentName: 'highValueCustomer',
        dataspaceName: 'default',
        dependsOn: [{ componentName: 'Divvy_TripsDmo', componentType: 'DataModelObject' }],
        entityPayload: { masterLabel: 'testCI' },
      },
    ];

    it('POSTs the versioned deploy path with the JSON-stringified request body', async () => {
      const { conn, calls } = makeConn({ response: { status: 'SUBMITTED', jobId: '08PVF000002iQIb' } });
      await createPromotion(conn, sampleRequest);

      expect(calls).to.have.lengthOf(1);
      const call = calls[0];
      expect(call).to.be.an('object');
      const req = call as { method?: string; url?: string; body?: unknown };
      expect(req.method).to.equal('POST');
      expect(req.url).to.equal('/services/data/v62.0/ssot/devops/component/promotion');
      expect(req.body).to.equal(JSON.stringify({ components: sampleRequest }));
      // The serialized body wraps the components array in a top-level `components` object.
      expect(req.body)
        .to.be.a('string')
        .and.to.match(/^\{"components":\[/);
    });

    it('returns the parsed submission ack verbatim ({ status: "SUBMITTED", jobId })', async () => {
      const { conn } = makeConn({ response: { status: 'SUBMITTED', jobId: '08PVF000002iQIb' } });
      const resp = await createPromotion(conn, sampleRequest);
      expect(resp).to.deep.equal({ status: 'SUBMITTED', jobId: '08PVF000002iQIb' });
      expect(resp.jobId).to.equal('08PVF000002iQIb');
    });

    it('maps an invalid session to an actionable auth error', async () => {
      const { conn } = makeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await createPromotion(conn, sampleRequest);
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiAuthError');
      }
    });

    it('maps a 404 to an actionable not-found error', async () => {
      const { conn } = makeConn({ reject: { name: 'NOT_FOUND', message: 'gone' } });
      try {
        await createPromotion(conn, sampleRequest);
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiNotFoundError');
      }
    });

    it('maps a DNS/domain failure to a network error', async () => {
      const { conn } = makeConn({ reject: { name: 'DomainNotFoundError', message: 'getaddrinfo ENOTFOUND' } });
      try {
        await createPromotion(conn, sampleRequest);
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiNetworkError');
      }
    });

    it('falls back to a generic API error for unrecognized failures', async () => {
      const { conn } = makeConn({ reject: { errorCode: 'WEIRD_BACKEND_ERROR', message: 'something odd' } });
      try {
        await createPromotion(conn, sampleRequest);
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiError');
        expect((err as SfError).message).to.include('something odd');
      }
    });

    it('does NOT emit telemetry (the deploy orchestration event is emitted by deploy-service)', async () => {
      const telemetry: TelemetryEvent[] = [];
      captureTelemetry(telemetry);
      try {
        const { conn } = makeConn({ response: { status: 'SUBMITTED' } });
        await createPromotion(conn, sampleRequest);
        expect(ourEvents(telemetry)).to.have.lengthOf(0);
      } finally {
        resetTelemetry();
      }
    });
  });

  describe('getPromotionStatus (deploy status GET)', () => {
    const sampleResponse = {
      jobId: '08PVF000002iQIb',
      status: 'InProgress',
      components: [{ componentName: 'MyCi', componentType: 'CalculatedInsight', status: 'InProgress' }],
    };

    it('GETs the versioned promotion-status path with the jobId as a path segment', async () => {
      const { conn, calls } = makeConn({ response: sampleResponse });
      await getPromotionStatus(conn, '08PVF000002iQIb');
      expect(calls[0]).to.equal('/services/data/v62.0/ssot/devops/component/promotion/08PVF000002iQIb');
    });

    it('URL-encodes a jobId containing a space and a slash', async () => {
      const { conn, calls } = makeConn({ response: sampleResponse });
      await getPromotionStatus(conn, 'weird id/2');
      expect(calls[0]).to.equal('/services/data/v62.0/ssot/devops/component/promotion/weird%20id%2F2');
    });

    it('returns the parsed response body verbatim (PascalCase enums untouched at this boundary)', async () => {
      const { conn } = makeConn({ response: sampleResponse });
      expect(await getPromotionStatus(conn, '08PVF000002iQIb')).to.deep.equal(sampleResponse);
    });

    it('maps a 404 to an actionable not-found error', async () => {
      const { conn } = makeConn({ reject: { name: 'NOT_FOUND', message: 'no such job' } });
      try {
        await getPromotionStatus(conn, '08PVF000002iQIb');
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiNotFoundError');
      }
    });

    it('maps an invalid session to an actionable auth error', async () => {
      const { conn } = makeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await getPromotionStatus(conn, '08PVF000002iQIb');
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiAuthError');
      }
    });

    it('does NOT emit telemetry (the poll event is emitted by deploy-status-service)', async () => {
      const telemetry: TelemetryEvent[] = [];
      captureTelemetry(telemetry);
      try {
        const { conn } = makeConn({ response: sampleResponse });
        await getPromotionStatus(conn, '08PVF000002iQIb');
        expect(ourEvents(telemetry)).to.have.lengthOf(0);
      } finally {
        resetTelemetry();
      }
    });
  });

  describe('error mapping (toSfError)', () => {
    it('maps an invalid session to an actionable auth error', async () => {
      const { conn } = makeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await getComponentTypes(conn);
        expect.fail('expected an SfError');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('DataCloudApiAuthError');
        expect((err as SfError).actions?.join(' ')).to.match(/org login/i);
      }
    });

    it('maps a 404 to an actionable not-found error', async () => {
      const { conn } = makeConn({ reject: { name: 'NOT_FOUND', message: 'The requested resource does not exist' } });
      try {
        await getComponents(conn, 'CalculatedInsight', 'default');
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiNotFoundError');
        expect((err as SfError).actions).to.have.length.greaterThan(0);
      }
    });

    it('maps a DNS/domain failure to a network error', async () => {
      const { conn } = makeConn({ reject: { name: 'DomainNotFoundError', message: 'getaddrinfo ENOTFOUND' } });
      try {
        await getSnapshot(conn, 'CalculatedInsight', 'highValueCustomer', 'default');
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiNetworkError');
      }
    });

    it('maps a raw connection-refused message to a network error', async () => {
      const { conn } = makeConn({ reject: new Error('connect ECONNREFUSED 127.0.0.1:443') });
      try {
        await getComponentTypes(conn);
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiNetworkError');
      }
    });

    it('falls back to a generic API error for unrecognized failures', async () => {
      const { conn } = makeConn({ reject: { errorCode: 'WEIRD_BACKEND_ERROR', message: 'something odd' } });
      try {
        await getComponents(conn, 'CalculatedInsight', 'default');
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiError');
        expect((err as SfError).message).to.include('something odd');
      }
    });
  });

  describe('telemetry', () => {
    let telemetry: TelemetryEvent[];

    beforeEach(() => {
      telemetry = [];
      captureTelemetry(telemetry);
    });

    afterEach(() => {
      resetTelemetry();
    });

    it('emits a safe API_REQUEST success event for component types (no componentType key, real count)', async () => {
      const { conn } = makeConn({
        response: { supportedComponentTypes: { CalculatedInsight: 'Calculated Insight', DataModelObject: 'DMO' } },
      });
      await getComponentTypes(conn);

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.eventName).to.equal('DATACLOUD_DEVOPS_API_REQUEST');
      expect(e.surface).to.equal('cli');
      expect(e.correlationId).to.match(UUID_RE); // client-generated CLI-side trace id
      expect(e.operation).to.equal('componentTypes');
      expect(Object.keys(e)).to.not.include('componentType'); // no type arg for this fn
      expect(e.success).to.equal(true);
      expect(e.resultCount).to.equal(2);
      expect(Number.isInteger(e.durationMs)).to.equal(true);
      assertAllSafe(telemetry);
    });

    it('generates a fresh correlationId per request (not a constant)', async () => {
      const { conn: conn1 } = makeConn({ response: { supportedComponentTypes: {} } });
      const { conn: conn2 } = makeConn({ response: { supportedComponentTypes: {} } });
      await getComponentTypes(conn1);
      await getComponentTypes(conn2);

      const ids = ourEvents(telemetry).map((e) => e.correlationId);
      expect(ids).to.have.lengthOf(2);
      expect(ids[0]).to.match(UUID_RE);
      expect(ids[1]).to.match(UUID_RE);
      expect(ids[0]).to.not.equal(ids[1]);
    });

    it('emits a safe API_REQUEST success event for components (bounded type, real count)', async () => {
      const { conn } = makeConn({ response: { components: [{ componentName: 'a' }, { componentName: 'b' }] } });
      await getComponents(conn, 'CalculatedInsight', 'analytics_ds');

      const e = ourEvents(telemetry)[0];
      expect(e.operation).to.equal('components');
      expect(e.componentType).to.equal('CalculatedInsight'); // bounded TYPE; dataspace never emitted
      expect(e.success).to.equal(true);
      expect(e.resultCount).to.equal(2);
      assertAllSafe(telemetry); // also proves 'analytics_ds' did not leak
    });

    it('bounds a free-text component type to "other"', async () => {
      const { conn } = makeConn({ response: { components: [] } });
      await getComponents(conn, '/Users/me/secret', 'default');

      const e = ourEvents(telemetry)[0];
      expect(e.componentType).to.equal('other');
      assertAllSafe(telemetry);
    });

    it('emits a failure event with the mapped errorCode (never the message) and re-throws the SfError', async () => {
      const { conn } = makeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await getComponentTypes(conn);
        expect.fail('expected an SfError');
      } catch (err) {
        expect((err as SfError).name).to.equal('DataCloudApiAuthError'); // original mapping preserved
      }

      const events = ourEvents(telemetry);
      expect(events).to.have.lengthOf(1);
      const e = events[0];
      expect(e.correlationId).to.match(UUID_RE); // present on the failure path too
      expect(e.success).to.equal(false);
      expect(e.errorCode).to.equal('DataCloudApiAuthError');
      expect(e.resultCount).to.equal(0);
      // The raw err.message ('Session expired') must never reach telemetry — only the code is read.
      expect(Object.keys(e)).to.not.include('message');
      expect(JSON.stringify(e)).to.not.match(/Session expired/);
      assertAllSafe(telemetry);
    });

    it('maps each error branch to its code on the failure event', async () => {
      const cases: Array<{ reject: unknown; code: string }> = [
        { reject: { name: 'NOT_FOUND', message: 'gone' }, code: 'DataCloudApiNotFoundError' },
        { reject: { name: 'DomainNotFoundError', message: 'getaddrinfo ENOTFOUND' }, code: 'DataCloudApiNetworkError' },
        { reject: { errorCode: 'WEIRD_BACKEND_ERROR', message: 'something odd' }, code: 'DataCloudApiError' },
      ];
      for (const { reject, code } of cases) {
        telemetry.length = 0;
        const { conn } = makeConn({ reject });
        // eslint-disable-next-line no-await-in-loop
        await getComponents(conn, 'CalculatedInsight', 'default').catch(() => undefined);
        const e = ourEvents(telemetry)[0];
        expect(e.errorCode, `branch for ${code}`).to.equal(code);
      }
      // None of the rejected messages leaked.
      assertAllSafe(telemetry);
    });

    it('does NOT emit telemetry from getSnapshot (retrieve path is covered by retrieve-service)', async () => {
      const { conn } = makeConn({ response: { components: [] } });
      await getSnapshot(conn, 'CalculatedInsight', 'highValueCustomer', 'default');
      expect(ourEvents(telemetry)).to.have.lengthOf(0);
    });

    it('never lets a throwing telemetry listener mask the mapped SfError', async () => {
      Lifecycle.getInstance().onTelemetry(() => {
        throw new Error('telemetry boom');
      });
      const { conn } = makeConn({ reject: { errorCode: 'INVALID_SESSION_ID', message: 'Session expired' } });
      try {
        await getComponentTypes(conn);
        expect.fail('expected the original SfError');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('DataCloudApiAuthError');
      }
    });
  });
});
