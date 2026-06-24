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

/** Asserts a single telemetry event carries no unsafe key and no unsafe string value. */
export function assertNoUnsafeFields(event: TelemetryEvent): void {
  for (const key of FORBIDDEN_KEYS) {
    expect(Object.keys(event), `payload must not contain key "${key}"`).to.not.include(key);
  }
  for (const value of Object.values(event)) {
    if (typeof value === 'string') {
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
