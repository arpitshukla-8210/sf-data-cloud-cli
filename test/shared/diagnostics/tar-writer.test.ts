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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect } from 'chai';
import { tarball } from '../../../src/shared/diagnostics/tar-writer.js';

describe('diagnostics/tar-writer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-diag-tar-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const MTIME = new Date('2026-07-03T00:00:00Z');

  it('produces an archive whose length is a multiple of 512 and ends with two zero blocks', () => {
    const buf = tarball([{ name: 'a.txt', data: Buffer.from('hello'), mtime: MTIME }]);
    expect(buf.length % 512).to.equal(0);
    const trailer = buf.subarray(buf.length - 1024);
    expect(trailer.every((b) => b === 0)).to.equal(true);
  });

  it('round-trips through the system tar (gzip): entries list and extract with correct contents', () => {
    const entries = [
      { name: 'logs/one.ndjson', data: Buffer.from('{"a":1}\n{"b":2}\n'), mtime: MTIME },
      { name: 'manifest.json', data: Buffer.from('{"files":2}'), mtime: MTIME },
    ];
    const gz = gzipSync(tarball(entries));
    const archivePath = join(dir, 'bundle.tar.gz');
    writeFileSync(archivePath, gz);

    // `tar -tzf` must list both entries in order.
    const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' }).trim().split('\n');
    expect(listing).to.deep.equal(['logs/one.ndjson', 'manifest.json']);

    // `tar -xzf` must extract byte-identical contents.
    execFileSync('tar', ['-xzf', archivePath, '-C', dir]);
    expect(readFileSync(join(dir, 'logs/one.ndjson'), 'utf8')).to.equal('{"a":1}\n{"b":2}\n');
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).to.equal('{"files":2}');
  });

  it('handles an empty file (header + no data block, still 512-aligned)', () => {
    const gz = gzipSync(tarball([{ name: 'empty.txt', data: Buffer.alloc(0), mtime: MTIME }]));
    const archivePath = join(dir, 'empty.tar.gz');
    writeFileSync(archivePath, gz);
    execFileSync('tar', ['-xzf', archivePath, '-C', dir]);
    expect(readFileSync(join(dir, 'empty.txt'), 'utf8')).to.equal('');
  });

  it('throws for a name longer than the 100-byte USTAR field', () => {
    expect(() => tarball([{ name: 'x'.repeat(101), data: Buffer.from('y') }])).to.throw(/exceeds 100/);
  });
});
