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

import { readdir, stat, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { arch, platform, release } from 'node:os';
import { gzipSync } from 'node:zlib';
import { Env } from '@salesforce/kit';
import {
  DiagnosticsManifest,
  DiagnosticsManifestEntry,
  DiagnosticsResult,
  EnvironmentInfo,
  SAFE_ENV_ALLOWLIST,
} from '../types/diagnostics.js';
import { resolveDiagConfig } from '../diagnostics/config.js';
import { resolveLogDir } from '../diagnostics/storage.js';
import { getPluginVersion } from '../diagnostics/plugin-version.js';
import { tarball, TarEntry } from '../diagnostics/tar-writer.js';

/*
 * Service for `sf data-cloud diagnostics` (plan §"diagnostics-service.ts", Phase 3). Collects the
 * local NDJSON diagnostic logs the passive observer channel wrote, and packs them — plus a manifest
 * and (optionally) allowlisted environment info — into a single gzipped USTAR bundle for support.
 *
 * The bundle is safe to ship BY CONSTRUCTION, not by a scrub here: every value already passed through
 * redaction at write time, absolute paths were home-scrubbed, and `environment.json` is allowlist-only
 * (never a raw process.env dump). This service adds one more guard — a read cap — so a runaway log
 * directory can never OOM the command; when the cap is hit it sets `truncated` and reports what was
 * dropped rather than silently omitting files. It is otherwise pure and injectable (clock, log dir,
 * cap, timestamp are all parameters) so the whole thing unit-tests without the real platform.
 */

/** Default ceiling on total uncompressed log bytes read into memory before truncating (~200MB). */
export const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;

/** A collected log file: its archive-relative name, raw bytes, and mtime (for manifest + ordering). */
type CollectedFile = {
  name: string;
  data: Buffer;
  mtime: Date;
};

/** Options for {@link collectDiagnosticBundle}. Clock/dir/cap are injectable for deterministic tests. */
export type CollectDiagnosticBundleOptions = {
  /** Retention window: include log files modified within this many days. */
  days: number;
  /** Absolute path of the `.tar.gz` to write. */
  outputPath: string;
  /** Whether to include allowlisted environment info as `environment.json`. */
  includeEnv: boolean;
  /** ISO-8601 stamp for the manifest's generatedAt (injected by the command; keeps the service pure). */
  generatedAt: string;
  /** Wall clock for the age cutoff; defaults to now. */
  now?: Date;
  /** Explicit log directory to read from; defaults to the same dir the logger writes to. */
  logDir?: string;
  /** Override the read cap (tests force truncation with a tiny value); defaults to MAX_BUNDLE_BYTES. */
  maxBytes?: number;
  /** Env source for the allowlisted environment snapshot; defaults to the process environment. */
  env?: Env;
};

/** Whether a directory entry is one of our diagnostic files (active NDJSON or gzipped-stale). */
function isDiagLogFile(name: string): boolean {
  return name.endsWith('.ndjson') || name.endsWith('.ndjson.gz');
}

/**
 * Builds the allowlisted, non-sensitive environment snapshot. Only names in SAFE_ENV_ALLOWLIST are
 * ever read, so a secret sitting in the environment can never reach the bundle. Coarse runtime facts
 * (node/os) come from process/os, never from user input.
 */
export function buildEnvironmentInfo(env: Env = new Env()): EnvironmentInfo {
  const collected: Record<string, string> = {};
  for (const key of SAFE_ENV_ALLOWLIST) {
    const value = env.getString(key);
    if (value !== undefined && value.length > 0) {
      collected[key] = value;
    }
  }
  return {
    pluginVersion: getPluginVersion(),
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    env: collected,
  };
}

/**
 * Enumerates diagnostic log files in `dir` modified within the retention window, NEWEST FIRST (most
 * relevant to a fresh failure), reading each into memory until the byte cap would be exceeded. Returns
 * the files that fit plus whether anything was dropped. A missing/unreadable directory yields an empty
 * set (not an error) — there is simply nothing to bundle.
 */
async function collectLogFiles(
  dir: string,
  cutoffMs: number,
  maxBytes: number
): Promise<{ files: CollectedFile[]; truncated: boolean }> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { files: [], truncated: false };
  }

  // Stat each candidate; keep those within the retention window, sorted newest first.
  const candidates: Array<{ full: string; name: string; mtimeMs: number }> = [];
  for (const name of names) {
    if (!isDiagLogFile(name)) continue;
    const full = join(dir, name);
    try {
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(full);
      if (info.isFile() && info.mtimeMs >= cutoffMs) {
        candidates.push({ full, name, mtimeMs: info.mtimeMs });
      }
    } catch {
      continue; // Vanished/locked between readdir and stat — skip it.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const files: CollectedFile[] = [];
  let total = 0;
  let truncated = false;
  for (const candidate of candidates) {
    let data: Buffer;
    try {
      // eslint-disable-next-line no-await-in-loop
      data = await readFile(candidate.full);
    } catch {
      continue; // Unreadable — skip rather than fail the whole bundle.
    }
    if (total + data.length > maxBytes) {
      // Cap reached: stop here and flag it (the remaining, older files are dropped, never silently).
      truncated = true;
      break;
    }
    total += data.length;
    files.push({ name: candidate.name, data, mtime: new Date(candidate.mtimeMs) });
  }
  return { files, truncated };
}

/**
 * Collects the diagnostic bundle: gather in-window log files (under the read cap), build the manifest
 * and optional environment snapshot, encode a gzipped USTAR archive, and write it to `outputPath`.
 * Returns a summary the command renders and `--json` emits.
 */
export async function collectDiagnosticBundle(options: CollectDiagnosticBundleOptions): Promise<DiagnosticsResult> {
  const now = options.now ?? new Date();
  const maxBytes = options.maxBytes ?? MAX_BUNDLE_BYTES;
  const cutoffMs = now.getTime() - options.days * 24 * 60 * 60 * 1000;

  // Read from the same directory the logger writes to (SF_DATACLOUD_LOG_DIR override honored), unless
  // a test passes an explicit dir.
  const logDir = options.logDir ?? resolveLogDir({ override: resolveDiagConfig(options.env).logDirOverride });

  const { files, truncated } = await collectLogFiles(logDir, cutoffMs, maxBytes);
  const totalBytes = files.reduce((sum, f) => sum + f.data.length, 0);

  // Manifest: a self-describing index so support can read the bundle without extracting every file.
  const manifestFiles: DiagnosticsManifestEntry[] = files.map((f) => ({
    name: f.name,
    bytes: f.data.length,
    mtime: f.mtime.toISOString(),
  }));
  const manifest: DiagnosticsManifest = {
    pluginVersion: getPluginVersion(),
    generatedAt: options.generatedAt,
    days: options.days,
    logDir,
    files: manifestFiles,
    truncated,
    includedEnvironment: options.includeEnv,
  };

  // Assemble the archive entries: logs under logs/, manifest at root, env (allowlist-only) if asked.
  const entries: TarEntry[] = files.map((f) => ({
    name: `logs/${f.name}`,
    data: f.data,
    mtime: f.mtime,
  }));
  entries.push({ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), mtime: now });
  if (options.includeEnv) {
    const environment = buildEnvironmentInfo(options.env);
    entries.push({
      name: 'environment.json',
      data: Buffer.from(`${JSON.stringify(environment, null, 2)}\n`),
      mtime: now,
    });
  }

  // Encode → gzip → write, creating the output's parent directory if needed.
  const gz = gzipSync(tarball(entries));
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, gz);

  return {
    outputPath: options.outputPath,
    fileCount: files.length,
    totalBytes,
    truncated,
    includedEnvironment: options.includeEnv,
  };
}

/** Default output file name for the bundle, stamped with a filesystem-safe timestamp. */
export function defaultOutputName(stamp: string): string {
  return `datacloud-diagnostics-${stamp}.tar.gz`;
}
