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
 * Minimal WRITE-ONLY USTAR tar encoder (plan §"tar-writer.ts", Dependency Decision). Node ships gzip
 * (node:zlib) but no tar, and the project's hard rule is to prefer builtins over new npm deps — so
 * the diagnostics bundle command hand-rolls the ~80 lines of tar framing here and pipes the result
 * through gzipSync. Scope is deliberately tiny: regular files only, POSIX/USTAR format, names ≤100
 * bytes (bundle entries are short, controlled paths like `logs/<file>.ndjson`). Pure and
 * deterministic (mtime is caller-supplied), so a `tar -tzf` round-trip test fully covers it.
 *
 * USTAR layout: each entry is a 512-byte header block followed by the file data padded up to a
 * 512-byte boundary; the archive ends with two all-zero 512-byte blocks.
 */

const BLOCK_SIZE = 512;
const NAME_MAX = 100;

/** One file to place in the archive. */
export type TarEntry = {
  /** Archive-relative path, ≤100 bytes UTF-8 (e.g. 'logs/2026-07-03.ndjson', 'manifest.json'). */
  name: string;
  /** File contents. */
  data: Buffer;
  /** Modification time (seconds since epoch resolution). Caller-supplied for determinism. */
  mtime?: Date;
  /** POSIX mode bits; defaults to 0o644. */
  mode?: number;
};

/** Writes an ASCII string into `buf` at `offset`, NUL-padding up to `len` bytes. */
function writeString(buf: Buffer, str: string, offset: number, len: number): void {
  // `write` truncates to `len`; remaining bytes stay zero (Buffer.alloc zero-fills).
  buf.write(str, offset, len, 'ascii');
}

/**
 * Writes a value as a fixed-width octal field: `len-1` octal digits, left-zero-padded, then a NUL.
 * This is the classic tar numeric-field convention (size, mode, mtime, checksum).
 */
function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  const octal = Math.floor(value).toString(8);
  const field = octal.slice(-(len - 1)).padStart(len - 1, '0');
  buf.write(field, offset, len - 1, 'ascii');
  // buf[offset + len - 1] stays 0x00 (the terminating NUL).
}

/** Builds one 512-byte USTAR header block for a regular file. */
function buildHeader(entry: TarEntry): Buffer {
  const nameBytes = Buffer.byteLength(entry.name, 'utf8');
  if (nameBytes > NAME_MAX) {
    throw new Error(`tar entry name exceeds ${NAME_MAX} bytes: ${entry.name}`);
  }
  const header = Buffer.alloc(BLOCK_SIZE);

  writeString(header, entry.name, 0, 100); // name
  writeOctal(header, entry.mode ?? 0o644, 100, 8); // mode
  writeOctal(header, 0, 108, 8); // uid
  writeOctal(header, 0, 116, 8); // gid
  writeOctal(header, entry.data.length, 124, 12); // size
  writeOctal(header, Math.floor((entry.mtime ?? new Date(0)).getTime() / 1000), 136, 12); // mtime
  header.write('        ', 148, 8, 'ascii'); // checksum field: 8 spaces while computing
  header.write('0', 156, 1, 'ascii'); // typeflag '0' = regular file
  // linkname (157,100) left zero.
  header.write('ustar\0', 257, 6, 'ascii'); // magic
  header.write('00', 263, 2, 'ascii'); // version
  // uname/gname/devmajor/devminor left zero.

  // Checksum = sum of all header bytes with the checksum field taken as spaces (written above),
  // then encoded as a 6-digit octal followed by NUL and a space (the canonical tar encoding).
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  const checksum = sum.toString(8).slice(-6).padStart(6, '0');
  header.write(checksum, 148, 6, 'ascii');
  header[154] = 0; // NUL
  header.write(' ', 155, 1, 'ascii'); // space

  return header;
}

/** Zero-padding needed to round `size` up to the next 512-byte block. */
function padTo512(size: number): Buffer {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK_SIZE - remainder);
}

/**
 * Encodes `entries` into a single USTAR tarball Buffer (uncompressed). Callers gzip the result
 * (node:zlib gzipSync) to produce the `.tar.gz`. Deterministic given deterministic mtimes.
 */
export function tarball(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(buildHeader(entry));
    chunks.push(entry.data);
    chunks.push(padTo512(entry.data.length));
  }
  // Two 512-byte zero blocks terminate the archive.
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(chunks);
}
