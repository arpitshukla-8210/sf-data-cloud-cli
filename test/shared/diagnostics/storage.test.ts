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

import { mkdtempSync, rmSync, writeFileSync, readdirSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'chai';
import {
  resolveLogDir,
  logFileName,
  slugifyCommand,
  fileTimestamp,
  homeScrub,
  nextRotatedPath,
  maintainLogDir,
  ROTATION,
} from '../../../src/shared/diagnostics/storage.js';

describe('diagnostics/storage', () => {
  describe('resolveLogDir', () => {
    it('uses the explicit override first', () => {
      expect(resolveLogDir({ override: '/custom/dir', platform: 'darwin', home: '/Users/x' })).to.equal('/custom/dir');
    });

    it('macOS → ~/Library/Logs/<app>', () => {
      const dir = resolveLogDir({ platform: 'darwin', home: '/Users/x' });
      expect(dir).to.equal('/Users/x/Library/Logs/salesforce-datacloud-devops');
    });

    it('Windows → %LOCALAPPDATA%/<app>/logs', () => {
      const dir = resolveLogDir({
        platform: 'win32',
        home: 'C:\\Users\\x',
        env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' },
      });
      expect(dir).to.match(/AppData.Local.salesforce-datacloud-devops.logs$/);
    });

    it('Linux → XDG_STATE_HOME/<app>/logs, defaulting under ~/.local/state', () => {
      expect(resolveLogDir({ platform: 'linux', home: '/home/x', env: {} })).to.equal(
        '/home/x/.local/state/salesforce-datacloud-devops/logs'
      );
      expect(resolveLogDir({ platform: 'linux', home: '/home/x', env: { XDG_STATE_HOME: '/xdg' } })).to.equal(
        '/xdg/salesforce-datacloud-devops/logs'
      );
    });
  });

  describe('naming helpers', () => {
    it('slugifies a command id', () => {
      expect(slugifyCommand('data-cloud deploy')).to.equal('data-cloud-deploy');
      expect(slugifyCommand('  weird::Name  ')).to.equal('weird-name');
    });

    it('produces a filesystem-safe UTC timestamp', () => {
      expect(fileTimestamp(new Date('2026-07-03T18:22:01.123Z'))).to.equal('2026-07-03T18-22-01');
    });

    it('builds a deterministic per-invocation file name', () => {
      const name = logFileName(
        new Date('2026-07-03T18:22:01.000Z'),
        'data-cloud deploy',
        'abcdef12-3456-7890-abcd-ef1234567890'
      );
      expect(name).to.equal('2026-07-03T18-22-01.data-cloud-deploy.abcdef.ndjson');
    });
  });

  describe('homeScrub', () => {
    it('replaces the home prefix with ~', () => {
      expect(homeScrub('/Users/alice/data-cloud/x.json', '/Users/alice')).to.equal('~/data-cloud/x.json');
    });

    it('is a no-op when home is unknown/trivial', () => {
      expect(homeScrub('/a/b', '')).to.equal('/a/b');
      expect(homeScrub('/a/b', '/')).to.equal('/a/b');
    });
  });

  describe('nextRotatedPath', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dc-diag-rot-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('inserts an incrementing .N before the extension, skipping existing slots', () => {
      const base = join(dir, 'a.ndjson');
      expect(nextRotatedPath(base)).to.equal(join(dir, 'a.1.ndjson'));
      writeFileSync(join(dir, 'a.1.ndjson'), '');
      expect(nextRotatedPath(base)).to.equal(join(dir, 'a.2.ndjson'));
    });
  });

  describe('maintainLogDir', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'dc-diag-maint-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const ageFile = (name: string, daysOld: number): string => {
      const full = join(dir, name);
      writeFileSync(full, 'x\n');
      const when = new Date('2026-07-03T00:00:00Z').getTime() / 1000 - daysOld * 86_400;
      utimesSync(full, when, when);
      return full;
    };

    it('deletes files older than the retention window', () => {
      const old = ageFile('old.ndjson', ROTATION.retentionDays + 2);
      const fresh = ageFile('fresh.ndjson', 0);
      maintainLogDir(dir, { now: new Date('2026-07-03T00:00:00Z') });
      expect(existsSync(old)).to.equal(false);
      // fresh survives (possibly gzipped by the compaction pass) — its stem remains present.
      expect(readdirSync(dir).some((f) => f.startsWith('fresh.ndjson'))).to.equal(true);
      expect(fresh).to.be.a('string');
    });

    it('caps the number of retained files at maxFiles', () => {
      for (let i = 0; i < ROTATION.maxFiles + 5; i++) {
        ageFile(`f${i}.ndjson`, i * 0.01); // all within retention, staggered mtimes
      }
      maintainLogDir(dir, { now: new Date('2026-07-03T00:00:00Z') });
      expect(readdirSync(dir).length).to.be.at.most(ROTATION.maxFiles);
    });

    it('gzips a stale uncompressed file (one per pass)', () => {
      ageFile('a.ndjson', 1);
      ageFile('b.ndjson', 2);
      maintainLogDir(dir, { now: new Date('2026-07-03T00:00:00Z') });
      expect(readdirSync(dir).some((f) => f.endsWith('.gz'))).to.equal(true);
    });

    it('never touches the current file', () => {
      const current = ageFile('current.ndjson', ROTATION.retentionDays + 10);
      maintainLogDir(dir, { now: new Date('2026-07-03T00:00:00Z'), currentFile: current });
      expect(existsSync(current)).to.equal(true);
    });

    it('is a silent no-op on a missing directory', () => {
      expect(() => maintainLogDir(join(dir, 'does-not-exist'))).to.not.throw();
    });
  });
});
