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

/*
 * Pure type/enum vocabulary for the LOCAL diagnostic-logging channel (plan §"event.ts"). This is a
 * SECOND, independent observability channel that sits alongside — never inside — telemetry.ts: it
 * writes richer, nested, correlatable NDJSON to a rotating on-disk file for debugging a single run,
 * whereas telemetry emits bounded flat primitives to App Insights for aggregate metrics. Nothing
 * here imports anything or runs at load time, so importing this module is always free of side
 * effects (a plan invariant). The two channels never share code paths and diagnostics never routes
 * through emitTelemetry().
 */

/**
 * Numeric severities, ordered so a single `<=` compares an event's level against the active
 * threshold. `OFF` disables the channel entirely (the logger short-circuits to a no-op). The default
 * when nothing is configured is INFO (a confirmed product decision): every command writes bounded
 * INFO NDJSON out of the box, with DEBUG/TRACE opt-in via env var.
 */
export enum LogLevel {
  OFF = 0,
  ERROR = 1,
  INFO = 2,
  DEBUG = 3,
  TRACE = 4,
}

/**
 * Coarse subsystems a diagnostic event belongs to. Each can carry its own verbosity override
 * (`SF_DATACLOUD_LOG_LEVEL_API` / `_DEPLOY` / `_FILEIO`) so a user can crank one area to TRACE
 * without drowning in the others. `CORE` is the catch-all for logger/lifecycle events that belong to
 * no single subsystem and always follows the global level.
 */
export enum Subsystem {
  API = 'API',
  DEPLOY = 'DEPLOY',
  FILEIO = 'FILEIO',
  CORE = 'CORE',
}

/** The default active level when no env var is set (confirmed product decision: on-by-default). */
export const DEFAULT_LEVEL: LogLevel = LogLevel.INFO;

/** LogLevel -> canonical uppercase name, written verbatim into each NDJSON row's `level` field. */
export const LEVEL_NAME: Readonly<Record<LogLevel, string>> = {
  [LogLevel.OFF]: 'OFF',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.TRACE]: 'TRACE',
};

/** Uppercase name -> LogLevel, for parsing env vars. Callers should upper-case the input first. */
export const NAME_LEVEL: Readonly<Record<string, LogLevel>> = {
  OFF: LogLevel.OFF,
  ERROR: LogLevel.ERROR,
  INFO: LogLevel.INFO,
  DEBUG: LogLevel.DEBUG,
  TRACE: LogLevel.TRACE,
};

/**
 * A bounded, JSON-serializable error shape for the optional `error` field of a diagnostic event.
 * Only the structured, non-free-text bits (name + code) are guaranteed safe; `message` is included
 * for debugging but — like every value written — passes through redaction before it hits disk.
 */
export type DiagError = {
  name?: string;
  /** The SfError `code` (e.g. 'DataCloudApiAuthError'), when the error is an SfError. */
  code?: string;
  message?: string;
};

/**
 * One NDJSON row (one line) in a diagnostic log file. Required fields are always present; optional
 * fields appear only when relevant. `extra` is the free-form, possibly-nested bag that the local
 * channel is allowed to carry (unlike telemetry) — it is deep-redacted before serialization, and
 * PII-bearing values (raw names/paths) only reach it at DEBUG/TRACE per the tiered-privacy decision.
 */
export type DiagEvent = {
  /** ISO-8601 UTC timestamp, e.g. '2026-07-03T18:22:01.123Z' — minted at write time. */
  ts: string;
  /** Uppercase level name (see LEVEL_NAME). */
  level: string;
  /** Per-invocation correlation id; reuses each orchestrator's existing correlationId when bound. */
  correlation_id: string;
  /** Process id — disambiguates concurrent CLI invocations sharing one log directory. */
  pid: number;
  /** The command slug, e.g. 'data-cloud deploy'; defaults to 'data-cloud' when unbound. */
  command: string;
  /** The plugin's package.json version, or 'unknown' if it could not be read. */
  plugin_version: string;
  /** Human-readable one-line description of what happened. */
  msg: string;
  /** Machine-parseable event code, e.g. 'CMD_START', 'API_REQ_ERR'. */
  code?: string;
  /** Subsystem this event belongs to (API/DEPLOY/FILEIO/CORE). */
  subsystem?: string;
  /** Elapsed wall-clock for a completed phase, in ms. */
  duration_ms?: number;
  /** Free-form, deep-redacted context bag (counts, statuses, and — at DEBUG/TRACE — names/paths). */
  extra?: Record<string, unknown>;
  /** Structured error detail on ERROR events. */
  error?: DiagError;
};
