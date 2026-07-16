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

import { homedir, platform } from 'node:os';
import { join, basename, dirname, extname } from 'node:path';
import { readdirSync, statSync, unlinkSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

/*
 * On-disk placement + housekeeping for diagnostic log files (plan §"storage.ts"). Two concerns:
 *   1. WHERE logs live — a cross-platform, per-user directory (overridable by env), following each
 *      OS's convention (XDG state on Linux, ~/Library/Logs on macOS, %LOCALAPPDATA% on Windows).
 *   2. Keeping the directory BOUNDED — size-based rotation (driven by the logger's in-memory byte
 *      counter, so no per-write statSync), a file-count cap, age-based retention, and lazy gzip of
 *      stale files (at most one per maintenance pass, to amortize cost).
 * The pure helpers (resolveLogDir/logFileName/homeScrub/slugifyCommand) take injectable os/env
 * inputs so they unit-test deterministically without touching the real filesystem or platform.
 */

/** Directory segment under each platform's per-user base dir. */
const APP_SEGMENT = 'salesforce-datacloud-devops';

/** Rotation / retention policy (plan §Executive Summary). */
export const ROTATION = {
  /** Roll to a new file once the active one reaches this many bytes. */
  maxFileBytes: 50 * 1024 * 1024,
  /** Keep at most this many diagnostic files (newest wins); older are pruned. */
  maxFiles: 10,
  /** Delete files older than this many days. */
  retentionDays: 7,
} as const;

/** Injectable OS/env inputs, so directory resolution is testable across platforms. */
export type LogDirInputs = {
  /** SF_DATACLOUD_LOG_DIR override (already resolved by config.ts); wins over the platform default. */
  override?: string;
  /** 'darwin' | 'win32' | 'linux' | …; defaults to the real os.platform(). */
  platform?: NodeJS.Platform;
  /** The user's home directory; defaults to the real os.homedir(). */
  home?: string;
  /** A snapshot of the relevant env vars; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolves the directory diagnostic files are written to. Precedence: explicit override → platform
 * convention. Pure — computes a path string only; the logger is responsible for creating it.
 */
export function resolveLogDir(inputs: LogDirInputs = {}): string {
  if (inputs.override) {
    return inputs.override;
  }
  const plat = inputs.platform ?? platform();
  const home = inputs.home ?? homedir();
  const env = inputs.env ?? process.env;

  if (plat === 'darwin') {
    return join(home, 'Library', 'Logs', APP_SEGMENT);
  }
  if (plat === 'win32') {
    const base = env.LOCALAPPDATA?.trim() ?? join(home, 'AppData', 'Local');
    return join(base, APP_SEGMENT, 'logs');
  }
  // Linux and everything else: XDG state dir (logs are state, not cache), default ~/.local/state.
  const xdgState = env.XDG_STATE_HOME?.trim() ?? join(home, '.local', 'state');
  return join(xdgState, APP_SEGMENT, 'logs');
}

/** Makes a command id safe as a single filename segment: lower-case, non-alphanumerics → '-'. */
export function slugifyCommand(command: string): string {
  return (
    command
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'command'
  );
}

/** Compact filesystem-safe UTC stamp 'YYYY-MM-DDTHH-MM-SS' from a Date (colons → dashes). */
export function fileTimestamp(when: Date): string {
  // toISOString() → '2026-07-03T18:22:01.123Z'; drop millis/zone, swap ':' for '-'.
  return when.toISOString().slice(0, 19).replace(/:/g, '-');
}

/**
 * Deterministic per-invocation file name: `<ts>.<command-slug>.<correlation6>.ndjson`. The 6-char
 * correlation fragment (first 6 of the correlation UUID) keeps names unique when two invocations
 * start in the same second.
 */
export function logFileName(when: Date, command: string, correlationId: string): string {
  const corr6 = correlationId.replace(/-/g, '').slice(0, 6) || '000000';
  return `${fileTimestamp(when)}.${slugifyCommand(command)}.${corr6}.ndjson`;
}

/**
 * Replaces the user's home-directory prefix with '~' anywhere it appears in a path/string, so
 * absolute paths logged at DEBUG/TRACE never leak the account name in a shipped bundle. No-op when
 * the home dir is unknown or trivially short (guards against corrupting '/' or '').
 */
export function homeScrub(value: string, home: string = homedir()): string {
  if (!home || home.length < 2) {
    return value;
  }
  // split/join avoids regex-escaping the home path (which contains Windows backslashes, etc.).
  return value.split(home).join('~');
}

/** Whether a directory entry is one of our diagnostic files (active or gzipped). */
function isDiagLogFile(name: string): boolean {
  return name.endsWith('.ndjson') || name.endsWith('.ndjson.gz');
}

/**
 * Given the active file path, returns the next available rotated path by inserting a `.N` counter
 * before the `.ndjson` extension (`base.ndjson` → `base.1.ndjson` → `base.2.ndjson` …). Called only
 * on a rotation event (not per write), so the bounded existence probe is cheap.
 */
export function nextRotatedPath(currentPath: string): string {
  const dir = dirname(currentPath);
  const ext = extname(currentPath); // '.ndjson'
  const stem = basename(currentPath, ext);
  for (let n = 1; n < 10_000; n++) {
    const candidate = join(dir, `${stem}.${n}${ext}`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  // Pathological fallback: overwrite the last slot rather than loop forever.
  return join(dir, `${stem}.9999${ext}`);
}

/** Best-effort unlink — housekeeping must never throw into the fire-and-forget logger. */
function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Ignore: the file may already be gone or locked by another process. Best-effort by design.
    return;
  }
}

/** Gzips one file in place (`x.ndjson` → `x.ndjson.gz`, original removed). Best-effort. */
function gzipInPlace(path: string): void {
  try {
    const data = readFileSync(path);
    writeFileSync(`${path}.gz`, gzipSync(data));
    safeUnlink(path);
  } catch {
    // Leave the plain file as-is on any failure; it is still valid and will be retried/pruned later.
    return;
  }
}

/** Options for a maintenance pass (injectable clock + the current file to protect). */
export type MaintainInputs = {
  /** Wall clock for the age cutoff; defaults to now. */
  now?: Date;
  /** The active file for THIS process — never pruned or gzipped mid-write. */
  currentFile?: string;
};

/**
 * Prunes and compacts a log directory: (1) delete files older than the retention window, (2) keep
 * only the newest `maxFiles`, (3) gzip at most one stale uncompressed file (the oldest, least likely
 * to be in-progress). Entirely best-effort and self-contained: any error is swallowed so a full or
 * unwritable disk never affects a command. Never touches `currentFile`.
 */
export function maintainLogDir(dir: string, inputs: MaintainInputs = {}): void {
  const nowMs = (inputs.now ?? new Date()).getTime();
  const cutoffMs = nowMs - ROTATION.retentionDays * 24 * 60 * 60 * 1000;
  try {
    const files = readdirSync(dir)
      .filter(isDiagLogFile)
      .map((name) => {
        const full = join(dir, name);
        try {
          return { name, full, mtimeMs: statSync(full).mtimeMs };
        } catch {
          return undefined;
        }
      })
      .filter((f): f is { name: string; full: string; mtimeMs: number } => f !== undefined);

    // (1) age-based retention.
    const survivors = files.filter((f) => {
      if (f.mtimeMs < cutoffMs && f.full !== inputs.currentFile) {
        safeUnlink(f.full);
        return false;
      }
      return true;
    });

    // (2) count cap — keep the newest maxFiles, drop the rest (never the current file).
    survivors.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of survivors.slice(ROTATION.maxFiles)) {
      if (f.full !== inputs.currentFile) {
        safeUnlink(f.full);
      }
    }
    const kept = survivors.slice(0, ROTATION.maxFiles);

    // (3) gzip the OLDEST uncompressed, non-current file (one per pass to amortize cost).
    const gzipCandidate = kept
      .filter((f) => f.name.endsWith('.ndjson') && f.full !== inputs.currentFile)
      .sort((a, b) => a.mtimeMs - b.mtimeMs)[0];
    if (gzipCandidate) {
      gzipInPlace(gzipCandidate.full);
    }
  } catch {
    // Directory unreadable/missing — nothing to maintain. Best-effort.
    return;
  }
}
