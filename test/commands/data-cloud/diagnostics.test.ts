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
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TestContext } from '@salesforce/core/testSetup';
import { expect } from 'chai';
import { stubSfCommandUx } from '@salesforce/sf-plugins-core';
import DataCloudDiagnostics from '../../../src/commands/data-cloud/diagnostics.js';

/*
 * Exercises the thin command end-to-end against a real temp log directory (SF_DATACLOUD_LOG_DIR). The
 * command owns only flag parsing, the default output path, and the summary; the archive itself is the
 * service's job (covered in diagnostics-service.test.ts), so here we assert the wiring: flags flow
 * through, a real .tar.gz is written, and the summary/warnings render.
 */
describe('data-cloud diagnostics', () => {
  const $$ = new TestContext();
  let sfCommandStubs: ReturnType<typeof stubSfCommandUx>;
  let logDir: string;
  let outDir: string;
  let savedLogDir: string | undefined;

  beforeEach(() => {
    sfCommandStubs = stubSfCommandUx($$.SANDBOX);
    logDir = mkdtempSync(join(tmpdir(), 'dc-diag-cmd-logs-'));
    outDir = mkdtempSync(join(tmpdir(), 'dc-diag-cmd-out-'));
    savedLogDir = process.env.SF_DATACLOUD_LOG_DIR;
    process.env.SF_DATACLOUD_LOG_DIR = logDir;
  });

  afterEach(() => {
    if (savedLogDir === undefined) delete process.env.SF_DATACLOUD_LOG_DIR;
    else process.env.SF_DATACLOUD_LOG_DIR = savedLogDir;
    $$.restore();
    rmSync(logDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  });

  const seedLog = (name: string, contents: string): void => writeFileSync(join(logDir, name), contents);

  const loggedOutput = (): string =>
    sfCommandStubs.log
      .getCalls()
      .flatMap((c) => c.args)
      .join('\n');

  it('writes a bundle from the configured log dir and reports the summary', async () => {
    seedLog('2026-07-03T10-00-00.data-cloud-deploy.aaa111.ndjson', '{"code":"CMD_START"}\n');
    const outputPath = join(outDir, 'bundle.tar.gz');

    const result = await DataCloudDiagnostics.run(['--days', '5', '--output', outputPath]);

    expect(result.outputPath).to.equal(outputPath);
    expect(result.fileCount).to.equal(1);
    expect(result.includedEnvironment).to.equal(false);
    expect(existsSync(outputPath)).to.equal(true);

    const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' });
    expect(listing).to.include('logs/2026-07-03T10-00-00.data-cloud-deploy.aaa111.ndjson');
    expect(listing).to.include('manifest.json');

    const output = loggedOutput();
    expect(output).to.include(outputPath);
    expect(output).to.include('1 log file');
  });

  it('includes environment.json when --include-env is passed', async () => {
    seedLog('a.ndjson', '{"a":1}\n');
    const outputPath = join(outDir, 'bundle.tar.gz');

    const result = await DataCloudDiagnostics.run(['--include-env', '--output', outputPath]);

    expect(result.includedEnvironment).to.equal(true);
    const listing = execFileSync('tar', ['-tzf', outputPath], { encoding: 'utf8' });
    expect(listing).to.include('environment.json');
  });

  it('defaults to a timestamped output file when --output is omitted', async () => {
    seedLog('a.ndjson', '{"a":1}\n');

    const result = await DataCloudDiagnostics.run([]);

    expect(result.outputPath).to.match(/datacloud-diagnostics-.*\.tar\.gz$/);
    expect(existsSync(result.outputPath)).to.equal(true);
    // Clean up the default-named file (written under cwd).
    rmSync(result.outputPath, { force: true });
  });

  it('rejects a non-positive --days value', async () => {
    try {
      await DataCloudDiagnostics.run(['--days', '0', '--output', join(outDir, 'b.tar.gz')]);
      expect.fail('Should have failed');
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
      expect((error as Error).message).to.match(/days|greater|at least|expected/i);
    }
  });
});
