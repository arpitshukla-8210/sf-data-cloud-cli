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

import { Lifecycle } from '@salesforce/core';
import { FOLDER_BY_TYPE } from '../constants/component-paths.js';

/*
 * Single telemetry chokepoint for the Data Cloud DevOps plugin (PROJECT_KNOWLEDGE.md §2.4, §4.4).
 * Plugins emit domain-specific signals on the shared Lifecycle 'telemetry' channel; the sf CLI's
 * telemetry infrastructure (not this plugin) subscribes, enriches with command/version/duration,
 * and uploads. We centralize three guarantees here so they cannot drift across call sites:
 *   1. NEVER THROW / NEVER BLOCK — the body is try/caught and callers use `void`, so a listener or
 *      emit failure can never alter a command's return value or error propagation.
 *   2. NAMING — every event name is a DATACLOUD_DEVOPS_<VERB>_<NOUN> constant passed through here.
 *   3. SAFE FIELDS ONLY — the attrs type is a flat map of primitives, so a caller cannot accidentally
 *      attach a nested object, a raw API body, or a component-name struct.
 * Emitting with no registered listener is a safe no-op in @salesforce/core (emit() only debug-logs
 * when there are zero listeners). Tests subscribe via Lifecycle.getInstance().onTelemetry(...).
 */

/** Only flat, non-PII-shaped primitives may be attached to a telemetry event. */
export type TelemetryAttributes = Record<string, string | number | boolean>;

/**
 * Bounds a component type to the known catalog before it is attached to telemetry. `--component`
 * (TYPE:NAME) and `--component-type` are free text that the CLI does not validate against the
 * catalog, so a value like `/Users/me/secret` or `acct@corp.com` could otherwise reach telemetry.
 * Returns the type only when it is a known type; otherwise the bounded literal 'other'.
 */
export function safeComponentType(componentType: string): string {
  return Object.hasOwn(FOLDER_BY_TYPE, componentType) ? componentType : 'other';
}

/**
 * Emit one structured telemetry event. Fire-and-forget by design: callers MUST use `void` — this
 * function swallows its own failures and never rejects, so it cannot affect the caller's outcome.
 *
 * @param eventName - full event name, already in DATACLOUD_DEVOPS_<VERB>_<NOUN> form.
 * @param attributes - flat map of SAFE primitives only (counts, durationMs, booleans, type names,
 * structured error codes, lifecycle states). NEVER pass component names, paths, or error messages.
 */
export async function emitTelemetry(eventName: string, attributes: TelemetryAttributes): Promise<void> {
  try {
    // `surface` distinguishes the CLI from the future MCP / Agentforce surfaces (§2.5). Callers on a
    // real request path attach a client-generated `correlationId` (§2.4) as the CLI-side trace id;
    // propagating it as a request header to Connect API -> DataKit awaits the backend trace-header
    // contract. Mock-only events (deploy, deploy status) omit it — no real request is made.
    await Lifecycle.getInstance().emitTelemetry({ eventName, surface: 'cli', ...attributes });
  } catch {
    // Telemetry is best-effort: a listener/emit failure must never reach the caller. A real
    // statement (not a bare comment) is required so the `no-empty` lint rule passes.
    return;
  }
}
