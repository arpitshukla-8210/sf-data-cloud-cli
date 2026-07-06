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
import { Lifecycle } from '@salesforce/core';

/*
 * Shared helpers for telemetry tests. The plugin emits domain telemetry on the Lifecycle 'telemetry'
 * channel; these utilities subscribe to it and enforce the privacy contract (no component names,
 * dataspace names, paths, emails, or error messages) uniformly across every suite that emits.
 */

/** A captured telemetry payload (Lifecycle.onTelemetry hands callers a flat Record). */
export type TelemetryEvent = Record<string, unknown>;

/** RFC-4122 v4 UUID shape, for asserting a client-generated correlationId. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Registers a synchronous capture listener that pushes every emitted event into `sink`. The push
 * runs DURING emit() (before the awaited service/command call returns), so tests can assert on
 * `sink` immediately after awaiting the call — no flush needed.
 */
export function captureTelemetry(sink: TelemetryEvent[]): void {
  Lifecycle.getInstance().onTelemetry((data: Record<string, unknown>): Promise<void> => {
    sink.push(data);
    return Promise.resolve();
  });
}

/** Removes ALL telemetry listeners from the process-global singleton (call in afterEach). */
export function resetTelemetry(): void {
  Lifecycle.getInstance().removeAllListeners(Lifecycle.telemetryEventName);
}

/** Only the events this plugin emits (ignores any framework-level telemetry in the same process). */
export function ourEvents(sink: TelemetryEvent[]): TelemetryEvent[] {
  return sink.filter((e) => typeof e.eventName === 'string' && e.eventName.startsWith('DATACLOUD_DEVOPS_'));
}

// Keys that would carry customer data — none may ever appear in a telemetry payload.
const FORBIDDEN_KEYS = [
  'componentName',
  'componentNames',
  'dataspace',
  'dataspaceName',
  'dataSpaceName',
  'fileWriteLocation',
  'filesWritten',
  'manifestPath',
  'path',
  'targetComponent',
  'message',
  'error',
  'username',
  'email',
];

// Concrete unsafe values that appear in the mocks (component names, a dataspace, an error message)
// plus structural giveaways (a path separator or an @). A safe payload must match none of these.
const UNSAFE_VALUE =
  /highValueCustomer|Divvy_Trips|myTransform|myDLO|AccountDmo|HighValueCustomers|analytics_ds|invalid syntax|Session expired|ENOTFOUND|[\\/]|@/;

/*
 * Deliberate privacy relaxation (Jun 2026 team decision). Two narrowly-scoped exceptions to the
 * value scan, for production debugging — every OTHER key/event stays fully bounded:
 *   - `errorMessage` (error-path events): the raw mapped SfError text, which may contain backend
 *     detail; allowed as a value but the value is not scanned for UNSAFE_VALUE.
 *   - The DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE sub-event may carry the customer's OWN failing
 *     `componentName` (normally forbidden) and an unbounded `componentType`/`errorMessage`.
 */
const FREE_TEXT_KEYS = new Set(['errorMessage']);
const COMPONENT_FAILURE_EVENT = 'DATACLOUD_DEVOPS_DEPLOY_COMPONENT_FAILURE';
const COMPONENT_FAILURE_FREE_TEXT_KEYS = new Set(['componentName', 'componentType', 'errorMessage']);

/** Asserts a single telemetry event carries no unsafe key and no unsafe string value. */
export function assertNoUnsafeFields(event: TelemetryEvent): void {
  const isComponentFailure = event.eventName === COMPONENT_FAILURE_EVENT;
  // The failure sub-event is the one place componentName is allowed; every other key stays forbidden.
  const forbiddenKeys = isComponentFailure ? FORBIDDEN_KEYS.filter((k) => k !== 'componentName') : FORBIDDEN_KEYS;
  // Keys whose value is intentionally free text on this event, so excluded from the UNSAFE_VALUE scan.
  const freeTextKeys = isComponentFailure ? COMPONENT_FAILURE_FREE_TEXT_KEYS : FREE_TEXT_KEYS;

  for (const key of forbiddenKeys) {
    expect(Object.keys(event), `payload must not contain key "${key}"`).to.not.include(key);
  }
  for (const [key, value] of Object.entries(event)) {
    if (typeof value === 'string' && !freeTextKeys.has(key)) {
      expect(value, `string value "${value}" looks like unsafe (PII/customer) data`).to.not.match(UNSAFE_VALUE);
    }
  }
}

/** Runs the unsafe-field assertion over every plugin event captured in `sink`. */
export function assertAllSafe(sink: TelemetryEvent[]): void {
  for (const event of ourEvents(sink)) {
    assertNoUnsafeFields(event);
  }
}
