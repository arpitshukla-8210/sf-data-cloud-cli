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

import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { getDiagLogger, resetDiagLoggerForTest } from '../../../src/shared/diagnostics/logger.js';
import { Subsystem } from '../../../src/shared/diagnostics/event.js';

/*
 * Exercises the logger against a real temp directory driven through SF_DATACLOUD_LOG_DIR +
 * SF_DATACLOUD_LOG_LEVEL. Each test snapshots and restores the relevant env vars and resets the
 * process singleton so config is re-read per case.
 */
describe('diagnostics/logger', () => {
  let dir: string;
  const ENV_KEYS = [
    'SF_DATACLOUD_LOG_DIR',
    'SF_DATACLOUD_LOG_LEVEL',
    'SF_DATACLOUD_LOG_LEVEL_API',
    'SF_DATACLOUD_LOG_LEVEL_DEPLOY',
    'SF_DATACLOUD_LOG_LEVEL_FILEIO',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-diag-log-'));
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.SF_DATACLOUD_LOG_DIR = dir;
    resetDiagLoggerForTest();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetDiagLoggerForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Reads every NDJSON line written across all files in the temp dir, parsed. */
  const readRows = (): Array<Record<string, unknown>> =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      );

  it('writes an INFO row by default with all required schema fields', () => {
    const diag = getDiagLogger().begin({
      command: 'data-cloud deploy',
      correlationId: 'abcdef12-0000-0000-0000-000000000000',
    });
    // eslint-disable-next-line camelcase
    diag.info(Subsystem.DEPLOY, 'CMD_START', 'deploy started', { component_count: 2 });

    const rows = readRows();
    expect(rows).to.have.lengthOf(1);
    const row = rows[0];
    expect(row.level).to.equal('INFO');
    expect(row.code).to.equal('CMD_START');
    expect(row.command).to.equal('data-cloud deploy');
    expect(row.correlation_id).to.equal('abcdef12-0000-0000-0000-000000000000');
    expect(row.pid).to.equal(process.pid);
    expect(row.plugin_version).to.be.a('string');
    expect(row.ts).to.match(/^\d{4}-\d{2}-\d{2}T/);
    expect((row.extra as Record<string, unknown>).component_count).to.equal(2);
  });

  it('suppresses events below the active level (DEBUG hidden at default INFO)', () => {
    const diag = getDiagLogger().begin({ command: 'data-cloud deploy' });
    diag.debug(Subsystem.DEPLOY, 'DEP_WALK_START', 'walking');
    diag.info(Subsystem.DEPLOY, 'CMD_START', 'started');
    const rows = readRows();
    expect(rows.map((r) => r.code)).to.deep.equal(['CMD_START']);
  });

  it('OFF writes zero files (pure no-op)', () => {
    process.env.SF_DATACLOUD_LOG_LEVEL = 'OFF';
    resetDiagLoggerForTest();
    const diag = getDiagLogger().begin({ command: 'data-cloud deploy' });
    diag.info(Subsystem.DEPLOY, 'CMD_START', 'started');
    diag.error(Subsystem.DEPLOY, 'BOOM', 'nope');
    expect(readdirSync(dir)).to.have.lengthOf(0);
  });

  it('traceEnabled/debugEnabled reflect the configured level (hot-loop gate)', () => {
    process.env.SF_DATACLOUD_LOG_LEVEL = 'DEBUG';
    resetDiagLoggerForTest();
    const diag = getDiagLogger();
    expect(diag.debugEnabled(Subsystem.FILEIO)).to.equal(true);
    expect(diag.traceEnabled(Subsystem.FILEIO)).to.equal(false);
  });

  it('honors a subsystem override (FILEIO=TRACE while global stays INFO)', () => {
    process.env.SF_DATACLOUD_LOG_LEVEL_FILEIO = 'TRACE';
    resetDiagLoggerForTest();
    const diag = getDiagLogger().begin({ command: 'data-cloud deploy' });
    diag.trace(Subsystem.FILEIO, 'FILE_READ', 'read a file');
    diag.trace(Subsystem.API, 'X', 'api trace should be hidden');
    expect(readRows().map((r) => r.code)).to.deep.equal(['FILE_READ']);
  });

  it('redacts secrets in extra before writing', () => {
    process.env.SF_DATACLOUD_LOG_LEVEL = 'TRACE';
    resetDiagLoggerForTest();
    const diag = getDiagLogger().begin({ command: 'data-cloud deploy' });
    diag.trace(Subsystem.API, 'API_REQ_START', 'calling', { authorization: 'Bearer sk-secret-xyz' });
    const raw = readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('');
    expect(raw).to.not.include('sk-secret-xyz');
    expect(raw).to.include('<REDACTED>');
  });

  it('lifts duration_ms to the row field and captures a structured error', () => {
    process.env.SF_DATACLOUD_LOG_LEVEL = 'DEBUG';
    resetDiagLoggerForTest();
    const diag = getDiagLogger().begin({ command: 'data-cloud deploy' });
    // eslint-disable-next-line camelcase
    diag.info(Subsystem.DEPLOY, 'CMD_END', 'done', { duration_ms: 42 });
    diag.error(Subsystem.DEPLOY, 'CMD_ERR', 'failed', { err: new Error('kaboom') });
    const rows = readRows();
    const end = rows.find((r) => r.code === 'CMD_END')!;
    expect(end.duration_ms).to.equal(42);
    expect(end.extra as Record<string, unknown> | undefined).to.equal(undefined); // duration_ms lifted out, nothing left
    const err = rows.find((r) => r.code === 'CMD_ERR')!;
    expect((err.error as Record<string, unknown>).message).to.equal('kaboom');
  });

  it('never throws when the log directory is not writable', () => {
    // Point at a path whose parent is a file, so mkdir/append fail; the logger must swallow it.
    process.env.SF_DATACLOUD_LOG_DIR = '/dev/null/cannot/create/here';
    resetDiagLoggerForTest();
    const diag = getDiagLogger().begin({ command: 'data-cloud deploy' });
    expect(() => diag.info(Subsystem.DEPLOY, 'CMD_START', 'started')).to.not.throw();
  });

  it('getDiagLogger returns a stable singleton within a process', () => {
    expect(getDiagLogger()).to.equal(getDiagLogger());
  });

  it('begin does not mutate the parent binding', () => {
    const root = getDiagLogger();
    const child = root.begin({ command: 'data-cloud retrieve', correlationId: 'aaaaaa11-0000-0000-0000-000000000000' });
    child.info(Subsystem.API, 'RETRIEVE_START', 'go');
    root.info(Subsystem.API, 'ROOT_EVENT', 'root');
    const rows = readRows();
    const childRow = rows.find((r) => r.code === 'RETRIEVE_START')!;
    const rootRow = rows.find((r) => r.code === 'ROOT_EVENT')!;
    expect(childRow.command).to.equal('data-cloud retrieve');
    expect(rootRow.command).to.equal('data-cloud'); // default, unchanged by the child's begin()
  });
});
