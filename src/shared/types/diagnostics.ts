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
 * Type definitions for `sf data-cloud diagnostics` (plan §"diagnostics.ts"). The command bundles the
 * local NDJSON diagnostic logs (written by the passive observer channel) into a single shippable
 * `.tar.gz` for support. Nothing here touches the wire contract — these types describe only the local
 * bundle artifact and its manifest. The bundle is safe to ship BY CONSTRUCTION: every value in the
 * logs was redacted at write time, absolute paths were home-scrubbed, and `environment.json` is built
 * from an allowlist (never a raw dump of process.env).
 */

/**
 * The set of environment-variable names it is safe to record in `environment.json`. Strictly an
 * ALLOWLIST — anything not named here is never read, so tokens/secrets in the environment
 * (SFDX_/SF_ auth vars, proxy credentials, etc.) can never reach the bundle. Kept deliberately small
 * and diagnostic-only: the CLI/runtime identity plus this plugin's own log-config knobs.
 */
export const SAFE_ENV_ALLOWLIST: readonly string[] = [
  // This plugin's diagnostic-logging configuration (never carries a secret).
  'SF_DATACLOUD_LOG_LEVEL',
  'SF_DATACLOUD_LOG_LEVEL_API',
  'SF_DATACLOUD_LOG_LEVEL_DEPLOY',
  'SF_DATACLOUD_LOG_LEVEL_FILEIO',
  'SF_DATACLOUD_LOG_DIR',
  // Coarse CLI/runtime toggles useful for reproducing an environment; none are credentials.
  'SF_DISABLE_TELEMETRY',
  'NODE_ENV',
  'CI',
];

/**
 * Allowlisted, non-sensitive facts about the machine and runtime, captured only when `--include-env`
 * is passed. Every field is coarse and diagnostic — no usernames, no absolute paths, no org data.
 */
export type EnvironmentInfo = {
  /** The plugin's package.json version (or 'unknown' if it could not be read). */
  pluginVersion: string;
  /** process.version, e.g. 'v24.16.0'. */
  nodeVersion: string;
  /** os.platform(), e.g. 'darwin' | 'linux' | 'win32'. */
  platform: string;
  /** os.arch(), e.g. 'arm64' | 'x64'. */
  arch: string;
  /** os.release() — the kernel/OS release string; coarse, no host identity. */
  osRelease: string;
  /** The allowlisted environment variables that were actually set (name → value). */
  env: Record<string, string>;
};

/** One entry in the bundle manifest describing a single collected log file. */
export type DiagnosticsManifestEntry = {
  /** File name as it appears under `logs/` in the archive (never an absolute path). */
  name: string;
  /** Byte length of the file as placed under `logs/` in the archive (raw on-disk bytes). */
  bytes: number;
  /** File modification time, ISO-8601, for ordering/triage. */
  mtime: string;
};

/**
 * The `manifest.json` written into the bundle root: a self-describing index of what the archive
 * contains, so a support engineer can read it without extracting every file.
 */
export type DiagnosticsManifest = {
  /** The plugin version that produced the bundle. */
  pluginVersion: string;
  /** ISO-8601 timestamp the bundle was generated (injected by the command; the service is pure). */
  generatedAt: string;
  /** The `--days` retention window the collection honored. */
  days: number;
  /** Whether the log files were read from the platform-default dir or an SF_DATACLOUD_LOG_DIR override. */
  logDir: string;
  /** Per-file index of everything under `logs/`. */
  files: DiagnosticsManifestEntry[];
  /** True when the ~200MB read cap was hit and some files were omitted (never silent). */
  truncated: boolean;
  /** Whether `environment.json` is present in this bundle (i.e. `--include-env` was passed). */
  includedEnvironment: boolean;
};

/** Shape returned by `sf data-cloud diagnostics` (and what `--json` emits). */
export type DiagnosticsResult = {
  /** Absolute path of the `.tar.gz` written. */
  outputPath: string;
  /** Number of log files included in the bundle. */
  fileCount: number;
  /** Total uncompressed bytes of the included log files. */
  totalBytes: number;
  /** True when the read cap was hit and the bundle is a bounded subset (surfaced to the user). */
  truncated: boolean;
  /** Whether allowlisted environment info was included. */
  includedEnvironment: boolean;
};
