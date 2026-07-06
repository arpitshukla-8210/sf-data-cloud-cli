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
import { Env } from '@salesforce/kit';
import { resolveDiagConfig, parseLevel } from '../../../src/shared/diagnostics/config.js';
import { LogLevel, DEFAULT_LEVEL, Subsystem } from '../../../src/shared/diagnostics/event.js';

/** Builds a config from an explicit env map — keeps every case pure and deterministic. */
const cfg = (vars: Record<string, string>) => resolveDiagConfig(new Env(vars));

describe('diagnostics/config', () => {
  describe('parseLevel', () => {
    it('parses each known level case-insensitively', () => {
      expect(parseLevel('off')).to.equal(LogLevel.OFF);
      expect(parseLevel('Error')).to.equal(LogLevel.ERROR);
      expect(parseLevel('INFO')).to.equal(LogLevel.INFO);
      expect(parseLevel('  debug ')).to.equal(LogLevel.DEBUG);
      expect(parseLevel('TRACE')).to.equal(LogLevel.TRACE);
    });

    it('returns undefined for absent/empty/unknown values', () => {
      expect(parseLevel(undefined)).to.equal(undefined);
      expect(parseLevel('')).to.equal(undefined);
      expect(parseLevel('verbose')).to.equal(undefined);
    });
  });

  describe('resolveDiagConfig', () => {
    it('defaults to INFO (on by default) with no env set', () => {
      const c = cfg({});
      expect(c.globalLevel).to.equal(DEFAULT_LEVEL);
      expect(c.globalLevel).to.equal(LogLevel.INFO);
      expect(c.anyEnabled).to.equal(true);
      expect(c.levelFor(Subsystem.API)).to.equal(LogLevel.INFO);
    });

    it('honors a global level override', () => {
      const c = cfg({ SF_DATACLOUD_LOG_LEVEL: 'TRACE' });
      expect(c.globalLevel).to.equal(LogLevel.TRACE);
      expect(c.levelFor(Subsystem.DEPLOY)).to.equal(LogLevel.TRACE);
    });

    it('OFF disables the channel entirely', () => {
      const c = cfg({ SF_DATACLOUD_LOG_LEVEL: 'OFF' });
      expect(c.globalLevel).to.equal(LogLevel.OFF);
      expect(c.anyEnabled).to.equal(false);
    });

    it('a subsystem override wins over the global for that subsystem only', () => {
      const c = cfg({ SF_DATACLOUD_LOG_LEVEL: 'INFO', SF_DATACLOUD_LOG_LEVEL_API: 'TRACE' });
      expect(c.levelFor(Subsystem.API)).to.equal(LogLevel.TRACE);
      expect(c.levelFor(Subsystem.DEPLOY)).to.equal(LogLevel.INFO);
      expect(c.levelFor(Subsystem.FILEIO)).to.equal(LogLevel.INFO);
    });

    it('a subsystem override alone enables the channel even when the global is OFF', () => {
      const c = cfg({ SF_DATACLOUD_LOG_LEVEL: 'OFF', SF_DATACLOUD_LOG_LEVEL_FILEIO: 'DEBUG' });
      expect(c.anyEnabled).to.equal(true);
      expect(c.levelFor(Subsystem.FILEIO)).to.equal(LogLevel.DEBUG);
      expect(c.levelFor(Subsystem.API)).to.equal(LogLevel.OFF);
    });

    it('an invalid level falls back to the default (never silently disables)', () => {
      const c = cfg({ SF_DATACLOUD_LOG_LEVEL: 'nonsense' });
      expect(c.globalLevel).to.equal(DEFAULT_LEVEL);
    });

    it('exposes a trimmed log-dir override, or undefined when blank', () => {
      expect(cfg({ SF_DATACLOUD_LOG_DIR: '  /tmp/x  ' }).logDirOverride).to.equal('/tmp/x');
      expect(cfg({ SF_DATACLOUD_LOG_DIR: '   ' }).logDirOverride).to.equal(undefined);
      expect(cfg({}).logDirOverride).to.equal(undefined);
    });
  });
});
