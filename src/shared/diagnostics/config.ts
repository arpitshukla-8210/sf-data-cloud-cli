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

import { Env } from '@salesforce/kit';
import { DEFAULT_LEVEL, LogLevel, NAME_LEVEL, Subsystem } from './event.js';

/*
 * Pure verbosity/config resolution for the diagnostic channel (plan §"config.ts"). Reads env vars
 * through @salesforce/kit's Env (already a dependency — no raw process.env, mirroring how the rest
 * of the plugin reads config) and computes the effective level per subsystem. This module is PURE:
 * it never touches the filesystem, so it is trivially unit-testable by handing resolveDiagConfig a
 * throwaway Env. The concrete on-disk directory is resolved separately in storage.ts.
 *
 * Env vars (all optional):
 *   SF_DATACLOUD_LOG_LEVEL          global level (OFF|ERROR|INFO|DEBUG|TRACE); default INFO.
 *   SF_DATACLOUD_LOG_LEVEL_API      per-subsystem overrides; when set, win over the global for that
 *   SF_DATACLOUD_LOG_LEVEL_DEPLOY   subsystem only. An absent/invalid override inherits the global.
 *   SF_DATACLOUD_LOG_LEVEL_FILEIO
 *   SF_DATACLOUD_LOG_DIR            overrides the platform-default log directory (used by storage.ts).
 */

const GLOBAL_VAR = 'SF_DATACLOUD_LOG_LEVEL';
const DIR_VAR = 'SF_DATACLOUD_LOG_DIR';
const SUBSYSTEM_VAR: Readonly<Record<Subsystem, string>> = {
  [Subsystem.API]: 'SF_DATACLOUD_LOG_LEVEL_API',
  [Subsystem.DEPLOY]: 'SF_DATACLOUD_LOG_LEVEL_DEPLOY',
  [Subsystem.FILEIO]: 'SF_DATACLOUD_LOG_LEVEL_FILEIO',
  // CORE has no dedicated override — it always follows the global level.
  [Subsystem.CORE]: '',
};

/**
 * Parses a level name to its LogLevel, case-insensitively. Returns `undefined` for an absent, empty,
 * or unrecognized value so the CALLER decides what "no opinion" means (the global falls back to
 * DEFAULT_LEVEL; a subsystem override falls back to inheriting the global). Tolerant by design — a
 * typo'd env var never throws and never silently disables logging.
 */
export function parseLevel(raw?: string): LogLevel | undefined {
  if (!raw) return undefined;
  const level = NAME_LEVEL[raw.trim().toUpperCase()];
  return level; // undefined when not a known name.
}

/** Resolved, read-only diagnostic configuration for one process. */
export type DiagConfig = {
  /** The effective global level (never undefined — DEFAULT_LEVEL when unset/invalid). */
  readonly globalLevel: LogLevel;
  /** The SF_DATACLOUD_LOG_DIR override, or undefined to use the platform default (storage.ts). */
  readonly logDirOverride: string | undefined;
  /** True when at least one subsystem would write at all (fast no-op gate for the logger). */
  readonly anyEnabled: boolean;
  /** The effective level for a subsystem: its override if set, else the global. */
  levelFor(subsystem: Subsystem): LogLevel;
};

/**
 * Resolves the diagnostic configuration from the environment. Pure: pass a custom `Env` (e.g.
 * `new Env({ SF_DATACLOUD_LOG_LEVEL: 'TRACE' })`) in tests; defaults to the process environment.
 */
export function resolveDiagConfig(env: Env = new Env()): DiagConfig {
  const globalLevel = parseLevel(env.getString(GLOBAL_VAR)) ?? DEFAULT_LEVEL;

  // Resolve each subsystem's override once, up front (pure, cheap), so levelFor is a map lookup.
  const overrides = new Map<Subsystem, LogLevel>();
  for (const subsystem of Object.values(Subsystem)) {
    const varName = SUBSYSTEM_VAR[subsystem];
    const override = varName ? parseLevel(env.getString(varName)) : undefined;
    if (override !== undefined) {
      overrides.set(subsystem, override);
    }
  }

  const levelFor = (subsystem: Subsystem): LogLevel => overrides.get(subsystem) ?? globalLevel;

  // The channel does something iff at least one effective subsystem level is above OFF. With the
  // INFO default and no overrides, this is simply `globalLevel > OFF`.
  const anyEnabled = globalLevel > LogLevel.OFF || [...overrides.values()].some((level) => level > LogLevel.OFF);

  // Treat an empty/whitespace override as "not set" (fall back to the platform default in storage).
  const trimmedDir = env.getString(DIR_VAR)?.trim();
  const logDirOverride = trimmedDir ? trimmedDir : undefined;

  return { globalLevel, levelFor, logDirOverride, anyEnabled };
}
