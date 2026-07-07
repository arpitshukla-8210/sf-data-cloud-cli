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

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { DiagError, DiagEvent, LEVEL_NAME, LogLevel, Subsystem } from './event.js';
import { DiagConfig, resolveDiagConfig } from './config.js';
import { getPluginVersion } from './plugin-version.js';
import { logFileName, maintainLogDir, nextRotatedPath, resolveLogDir, ROTATION } from './storage.js';
import { redact, redactString } from './redact.js';

/*
 * The local diagnostic logger (plan §"logger.ts") — a PASSIVE OBSERVER, entirely separate from
 * telemetry.ts. Services obtain it lazily INSIDE a function (never at module scope) via
 * getDiagLogger(), optionally bind per-invocation context with .begin({...}), and emit events with
 * positional info/debug/trace/error(subsystem, code, msg, extra?). Guarantees, all load-bearing:
 *   - NEVER THROWS / NEVER BLOCKS: every write is a synchronous appendFileSync wrapped in try/catch;
 *     an unwritable disk, a redaction failure, anything — is swallowed. A diagnostic call can never
 *     alter a command's return value, output, or error propagation.
 *   - NO SIDE EFFECTS AT IMPORT: config/dir/version/file are resolved on first use, then cached. When
 *     the channel is disabled (anyEnabled === false) getDiagLogger() returns a no-op that opens no
 *     file and allocates nothing per call.
 *   - CHEAP WHEN OFF: level gates (debugEnabled/traceEnabled) let hot loops skip building `extra`.
 *   - BOUNDED ON DISK: an in-memory byte counter (never a per-write statSync) triggers rotation; a
 *     one-time maintenance pass prunes/gzips old files.
 */

/** Per-invocation binding for a child logger. Both fields optional (sensible defaults applied). */
export type BeginContext = {
  /** Command slug, e.g. 'data-cloud deploy'. Defaults to 'data-cloud'. */
  command?: string;
  /** Correlation id to stamp on events (reuse the orchestrator's). Defaults to a per-process UUID. */
  correlationId?: string;
};

/** Free-form context bag; deep-redacted before write. `duration_ms` is lifted to the row's duration_ms. */
export type DiagExtra = Record<string, unknown> & { duration_ms?: number };

/** The default command slug when begin() is not given one. */
const DEFAULT_COMMAND = 'data-cloud';

/**
 * The single file destination shared by the root logger and every child from begin() (one file per
 * process). Owns all mutable write state — active path, byte counter, one-time prepare flag — so the
 * DiagLogger stays immutable and no function mutates a shared parameter. Every method is best-effort;
 * the caller (DiagLogger.write) wraps invocations in try/catch.
 */
class FileSink {
  public readonly config: DiagConfig;
  private readonly dir: string;
  private readonly version: string;
  /** Active file path — created lazily on first write, then rotated in place by byte count. */
  private currentFile: string | undefined;
  /** Running total of bytes written to `currentFile`; drives rotation without touching the fs. */
  private bytesWritten = 0;
  /** Whether the one-time dir-ensure + maintenance pass has run this process. */
  private prepared = false;

  public constructor(config: DiagConfig) {
    this.config = config;
    this.dir = resolveLogDir({ override: config.logDirOverride });
    this.version = getPluginVersion();
  }

  /** The plugin version stamped on every row. */
  public get pluginVersion(): string {
    return this.version;
  }

  /** Ensures the file exists, appends the line, updates the byte counter, and rotates when full. */
  public append(line: string, command: string, correlationId: string): void {
    if (!this.prepared) {
      // One-time, best-effort: create the dir and prune/gzip stale files before the first write.
      mkdirSync(this.dir, { recursive: true });
      maintainLogDir(this.dir);
      this.prepared = true;
    }
    if (this.currentFile === undefined) {
      this.currentFile = `${this.dir}/${logFileName(new Date(), command, correlationId)}`;
      this.bytesWritten = 0;
    }
    appendFileSync(this.currentFile, line);
    this.bytesWritten += Buffer.byteLength(line);
    if (this.bytesWritten > ROTATION.maxFileBytes) {
      // Roll to the next `.N.ndjson` slot; the counter resets so no per-write statSync is needed.
      this.currentFile = nextRotatedPath(this.currentFile);
      this.bytesWritten = 0;
    }
  }
}

/**
 * The diagnostic logger. A single instance is shared per process (see getDiagLogger); begin() returns
 * a lightweight child that re-binds command/correlationId but shares the same underlying file sink.
 * A logger whose `sink` is undefined is a permanent no-op (channel disabled).
 */
export class DiagLogger {
  private readonly sink: FileSink | undefined;
  private readonly command: string;
  private readonly correlationId: string;

  public constructor(sink: FileSink | undefined, command: string, correlationId: string) {
    this.sink = sink;
    this.command = command;
    this.correlationId = correlationId;
  }

  /** Binds per-invocation context, returning a child that writes to the same file sink. */
  public begin(ctx: BeginContext = {}): DiagLogger {
    return new DiagLogger(this.sink, ctx.command ?? this.command, ctx.correlationId ?? this.correlationId);
  }

  /** Whether DEBUG events for `subsystem` would be written — gate hot-loop calls with this. */
  public debugEnabled(subsystem: Subsystem): boolean {
    return this.levelEnabled(LogLevel.DEBUG, subsystem);
  }

  /** Whether TRACE events for `subsystem` would be written — gate hot-loop calls with this. */
  public traceEnabled(subsystem: Subsystem): boolean {
    return this.levelEnabled(LogLevel.TRACE, subsystem);
  }

  public error(subsystem: Subsystem, code: string, msg: string, extra?: DiagExtra): void {
    this.write(LogLevel.ERROR, subsystem, code, msg, extra);
  }

  public info(subsystem: Subsystem, code: string, msg: string, extra?: DiagExtra): void {
    this.write(LogLevel.INFO, subsystem, code, msg, extra);
  }

  public debug(subsystem: Subsystem, code: string, msg: string, extra?: DiagExtra): void {
    this.write(LogLevel.DEBUG, subsystem, code, msg, extra);
  }

  public trace(subsystem: Subsystem, code: string, msg: string, extra?: DiagExtra): void {
    this.write(LogLevel.TRACE, subsystem, code, msg, extra);
  }

  /** Whether an event at `level` for `subsystem` clears the configured threshold. */
  private levelEnabled(level: LogLevel, subsystem: Subsystem): boolean {
    if (this.sink === undefined) return false;
    return level <= this.sink.config.levelFor(subsystem);
  }

  /**
   * The single write path. Level-gates, builds the row, redacts, and appends — all inside one
   * try/catch so it can never throw. Callers never await this; it is synchronous and best-effort.
   */
  private write(level: LogLevel, subsystem: Subsystem, code: string, msg: string, extra?: DiagExtra): void {
    const sink = this.sink;
    if (sink === undefined || !this.levelEnabled(level, subsystem)) {
      return;
    }
    try {
      const event = this.buildEvent(sink, level, subsystem, code, msg, extra);
      const line = JSON.stringify(event) + '\n';
      sink.append(line, this.command, this.correlationId);
    } catch {
      // Fire-and-forget: a serialization/redaction/fs failure must never reach the caller. A real
      // statement (not a bare comment) keeps the `no-empty` lint rule satisfied (see telemetry.ts).
      return;
    }
  }

  /** Assembles one NDJSON row. `duration_ms` is lifted to the row's duration_ms; the rest of extra is redacted. */
  private buildEvent(
    sink: FileSink,
    level: LogLevel,
    subsystem: Subsystem,
    code: string,
    msg: string,
    extra?: DiagExtra
  ): DiagEvent {
    /* eslint-disable camelcase */
    // The NDJSON row schema (event.ts, DiagEvent) uses snake_case field names by design — a stable
    // on-disk/log-ingest contract that matches the remote telemetry field names — so these keys are
    // intentionally not camelCase. `duration_ms` is destructured out of extra and lifted to the row.
    const { duration_ms: durationMs, err, ...rest } = (extra ?? {}) as DiagExtra & { err?: unknown };
    const event: DiagEvent = {
      ts: new Date().toISOString(),
      level: LEVEL_NAME[level],
      correlation_id: this.correlationId,
      pid: process.pid,
      command: this.command,
      plugin_version: sink.pluginVersion,
      msg: redactString(msg),
      code,
      subsystem,
    };
    if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
      event.duration_ms = durationMs;
    }
    /* eslint-enable camelcase */
    if (err !== undefined) {
      event.error = toDiagError(err);
    }
    if (Object.keys(rest).length > 0) {
      event.extra = redact(rest) as Record<string, unknown>;
    }
    return event;
  }
}

/** Best-effort conversion of an arbitrary thrown value to the bounded, redacted DiagError shape. */
function toDiagError(err: unknown): DiagError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      ...(typeof code === 'string' && { code }),
      message: redactString(err.message),
    };
  }
  return { message: redactString(typeof err === 'string' ? err : String(err)) };
}

/** Process-wide singleton (root logger), created on first getDiagLogger() call. */
let singleton: DiagLogger | undefined;

/**
 * Returns the process-shared diagnostic logger, constructing it on first use. When diagnostics are
 * disabled (anyEnabled === false) this returns a no-op logger that opens no file. Services call this
 * lazily inside a function and typically chain .begin({...}) to bind the invocation's correlationId.
 */
export function getDiagLogger(): DiagLogger {
  if (singleton !== undefined) {
    return singleton;
  }
  const config = resolveDiagConfig();
  if (!config.anyEnabled) {
    singleton = new DiagLogger(undefined, DEFAULT_COMMAND, 'disabled');
    return singleton;
  }
  // Per-process default correlation id; begin({ correlationId }) overrides it for a bound child.
  singleton = new DiagLogger(new FileSink(config), DEFAULT_COMMAND, randomUUID());
  return singleton;
}

/** Test seam: drops the cached singleton so the next getDiagLogger() re-reads the environment. */
export function resetDiagLoggerForTest(): void {
  singleton = undefined;
}
