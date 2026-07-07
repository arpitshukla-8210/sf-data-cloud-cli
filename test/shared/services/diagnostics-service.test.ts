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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import { Env } from '@salesforce/kit';
import {
  collectDiagnosticBundle,
  buildEnvironmentInfo,
  defaultOutputName,
} from '../../../src/shared/services/diagnostics-service.js';
import { SAFE_ENV_ALLOWLIST } from '../../../src/shared/types/diagnostics.js';

/*
 * The service is pure/injectable (clock, log dir, cap, timestamp are all parameters), so these tests
 * drive it against real temp directories and verify the produced archive with the system `tar`. No
 * org, no network, no dependence on the platform's real log dir.
 */
describe('diagnostics-service', () => {
  let logDir: string;
  let outDir: string;
  const NOW = new Date('2026-07-03T12:00:00Z');
  const GENERATED_AT = NOW.toISOString();

  beforeEach(() => {
    logDir = mkdtempSync(join(tmpdir(), 'dc-diag-svc-logs-'));
    outDir = mkdtempSync(join(tmpdir(), 'dc-diag-svc-out-'));
  });
  afterEach(() => {
    rmSync(logDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  /** Writes an NDJSON log file with a given age (days before NOW) and returns its full path. */
  const seedLog = (name: string, contents: string, daysOld = 0): string => {
    const full = join(logDir, name);
    writeFileSync(full, contents);
    const when = NOW.getTime() / 1000 - daysOld * 86_400;
    utimesSync(full, when, when);
    return full;
  };

  /** Extracts the archive to a fresh dir and returns that dir. */
  const extract = (archivePath: string): string => {
    const dest = mkdtempSync(join(tmpdir(), 'dc-diag-svc-x-'));
    execFileSync('tar', ['-xzf', archivePath, '-C', dest]);
    return dest;
  };

  describe('collectDiagnosticBundle', () => {
    it('bundles in-window log files under logs/ with a manifest and reports the summary', async () => {
      seedLog('2026-07-03T10-00-00.data-cloud-deploy.aaa111.ndjson', '{"code":"CMD_START"}\n', 0);
      seedLog('2026-07-02T10-00-00.data-cloud-retrieve.bbb222.ndjson', '{"code":"RETRIEVE_START"}\n', 1);
      const outputPath = join(outDir, 'bundle.tar.gz');

      const result = await collectDiagnosticBundle({
        days: 3,
        outputPath,
        includeEnv: false,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir,
      });

      expect(result.fileCount).to.equal(2);
      expect(result.truncated).to.equal(false);
      expect(result.includedEnvironment).to.equal(false);
      expect(existsSync(outputPath)).to.equal(true);

      const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' })
        .trim()
        .replace(/\r/g, '')
        .split('\n');
      expect(listing).to.include('logs/2026-07-03T10-00-00.data-cloud-deploy.aaa111.ndjson');
      expect(listing).to.include('logs/2026-07-02T10-00-00.data-cloud-retrieve.bbb222.ndjson');
      expect(listing).to.include('manifest.json');
      expect(listing).to.not.include('environment.json'); // includeEnv was false

      const dest = extract(outputPath);
      const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf8')) as {
        files: Array<{ name: string; bytes: number }>;
        days: number;
        truncated: boolean;
        generatedAt: string;
      };
      expect(manifest.days).to.equal(3);
      expect(manifest.truncated).to.equal(false);
      expect(manifest.generatedAt).to.equal(GENERATED_AT);
      expect(manifest.files).to.have.lengthOf(2);
      // Content round-trips byte-for-byte.
      expect(readFileSync(join(dest, 'logs/2026-07-03T10-00-00.data-cloud-deploy.aaa111.ndjson'), 'utf8')).to.equal(
        '{"code":"CMD_START"}\n'
      );
      rmSync(dest, { recursive: true, force: true });
    });

    it('excludes files older than the --days retention window', async () => {
      seedLog('recent.ndjson', '{"a":1}\n', 1);
      seedLog('stale.ndjson', '{"a":2}\n', 10);
      const outputPath = join(outDir, 'bundle.tar.gz');

      const result = await collectDiagnosticBundle({
        days: 3,
        outputPath,
        includeEnv: false,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir,
      });

      expect(result.fileCount).to.equal(1);
      const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' }).replace(/\r/g, '');
      expect(listing).to.include('logs/recent.ndjson');
      expect(listing).to.not.include('stale.ndjson');
    });

    it('ignores non-diagnostic files in the directory', async () => {
      seedLog('real.ndjson', '{"a":1}\n', 0);
      writeFileSync(join(logDir, 'notes.txt'), 'not a log');
      writeFileSync(join(logDir, 'config.json'), '{}');
      const outputPath = join(outDir, 'bundle.tar.gz');

      const result = await collectDiagnosticBundle({
        days: 3,
        outputPath,
        includeEnv: false,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir,
      });

      expect(result.fileCount).to.equal(1);
      const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' }).replace(/\r/g, '');
      expect(listing).to.not.include('notes.txt');
      expect(listing).to.not.include('config.json');
    });

    it('includes gzipped stale logs (.ndjson.gz) alongside active ones', async () => {
      seedLog('active.ndjson', '{"a":1}\n', 0);
      seedLog('rolled.ndjson.gz', 'not-really-gzip-but-named-so\n', 1);
      const outputPath = join(outDir, 'bundle.tar.gz');

      const result = await collectDiagnosticBundle({
        days: 3,
        outputPath,
        includeEnv: false,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir,
      });

      expect(result.fileCount).to.equal(2);
      const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' }).replace(/\r/g, '');
      expect(listing).to.include('logs/rolled.ndjson.gz');
    });

    it('sets truncated and drops the oldest files when the byte cap is exceeded', async () => {
      // Three ~1KB files; a 1500-byte cap admits only the two newest.
      const kb = 'x'.repeat(1024) + '\n';
      seedLog('newest.ndjson', kb, 0);
      seedLog('middle.ndjson', kb, 1);
      seedLog('oldest.ndjson', kb, 2);
      const outputPath = join(outDir, 'bundle.tar.gz');

      const result = await collectDiagnosticBundle({
        days: 30,
        outputPath,
        includeEnv: false,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir,
        maxBytes: 1500,
      });

      expect(result.truncated).to.equal(true);
      expect(result.fileCount).to.equal(1); // only the single newest 1KB file fits under 1500 bytes
      const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' }).replace(/\r/g, '');
      expect(listing).to.include('logs/newest.ndjson');
      expect(listing).to.not.include('oldest.ndjson');
    });

    it('produces an empty (but valid) bundle when the log directory does not exist', async () => {
      const outputPath = join(outDir, 'bundle.tar.gz');
      const result = await collectDiagnosticBundle({
        days: 3,
        outputPath,
        includeEnv: false,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir: join(logDir, 'nope'),
      });

      expect(result.fileCount).to.equal(0);
      expect(result.truncated).to.equal(false);
      expect(existsSync(outputPath)).to.equal(true);
      // The archive still lists a manifest (and extracts cleanly).
      const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' }).replace(/\r/g, '');
      expect(listing).to.include('manifest.json');
    });

    it('adds an allowlist-only environment.json when includeEnv is set', async () => {
      seedLog('a.ndjson', '{"a":1}\n', 0);
      const outputPath = join(outDir, 'bundle.tar.gz');

      const result = await collectDiagnosticBundle({
        days: 3,
        outputPath,
        includeEnv: true,
        generatedAt: GENERATED_AT,
        now: NOW,
        logDir,
        // A secret-looking var NOT on the allowlist must never appear.
        env: new Env({ SF_DATACLOUD_LOG_LEVEL: 'TRACE', SFDX_ACCESS_TOKEN: 'sk-should-never-appear' }),
      });

      expect(result.includedEnvironment).to.equal(true);
      const dest = extract(outputPath);
      const raw = readFileSync(join(dest, 'environment.json'), 'utf8');
      const env = JSON.parse(raw) as { env: Record<string, string>; nodeVersion: string };
      expect(env.env.SF_DATACLOUD_LOG_LEVEL).to.equal('TRACE');
      expect(raw).to.not.include('SFDX_ACCESS_TOKEN');
      expect(raw).to.not.include('sk-should-never-appear');
      expect(env.nodeVersion).to.be.a('string');
      rmSync(dest, { recursive: true, force: true });
    });
  });

  describe('buildEnvironmentInfo', () => {
    it('reads only allowlisted env vars and captures coarse runtime facts', () => {
      const info = buildEnvironmentInfo(
        new Env({ SF_DATACLOUD_LOG_LEVEL: 'DEBUG', HOME: '/Users/secret', AWS_SECRET_ACCESS_KEY: 'nope' })
      );
      expect(info.env.SF_DATACLOUD_LOG_LEVEL).to.equal('DEBUG');
      expect(Object.keys(info.env)).to.not.include('HOME');
      expect(Object.keys(info.env)).to.not.include('AWS_SECRET_ACCESS_KEY');
      expect(info.pluginVersion).to.be.a('string');
      expect(info.nodeVersion).to.equal(process.version);
      expect(info.platform).to.be.a('string');
    });

    it('omits allowlisted vars that are not set (only present ones are recorded)', () => {
      const info = buildEnvironmentInfo(new Env({}));
      for (const key of SAFE_ENV_ALLOWLIST) {
        expect(Object.keys(info.env), key).to.not.include(key);
      }
    });
  });

  describe('defaultOutputName', () => {
    it('builds a timestamped .tar.gz name', () => {
      expect(defaultOutputName('2026-07-03T12-00-00')).to.equal('datacloud-diagnostics-2026-07-03T12-00-00.tar.gz');
    });
  });
});
