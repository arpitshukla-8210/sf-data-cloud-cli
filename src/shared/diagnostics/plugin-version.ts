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

import { readFileSync } from 'node:fs';

/*
 * Resolves the plugin's own version string for the `plugin_version` field of every diagnostic event
 * (plan §"plugin-version.ts"). Services can't reach the command layer's `this.config.version`, so we
 * read our own package.json directly. Hardened + lazy: the read happens on the FIRST call (never at
 * module load — a plan invariant that keeps importing the diagnostics layer free of fs side effects),
 * is memoized thereafter, and any failure degrades to the literal 'unknown' rather than throwing.
 */

/** Sentinel when the version can't be read; a valid, bounded value for the NDJSON `plugin_version`. */
const UNKNOWN = 'unknown';

/** Memoized result; `undefined` means "not yet resolved" (distinct from a resolved 'unknown'). */
let cached: string | undefined;

/**
 * The plugin's package.json `version`, memoized. Both `src/shared/diagnostics/` (ts-node dev) and
 * `lib/shared/diagnostics/` (compiled) sit three levels below the package root, so the same relative
 * URL resolves package.json in either mode. Returns 'unknown' on any read/parse failure.
 */
export function getPluginVersion(): string {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const pkgUrl = new URL('../../../package.json', import.meta.url);
    const raw = readFileSync(pkgUrl, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : UNKNOWN;
  } catch {
    cached = UNKNOWN;
  }
  return cached;
}

/** Test seam: clears the memoized value so a suite can re-exercise the resolve/fallback path. */
export function resetPluginVersionForTest(): void {
  cached = undefined;
}
