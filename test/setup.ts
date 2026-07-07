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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * Global test bootstrap (referenced from .mocharc.json `require`). Runs ONCE before any test file is
 * loaded. Its sole job is a side-effect-containment guard for the diagnostic logger: because that
 * channel defaults to INFO (on by default), any test that drives a real orchestrator would otherwise
 * write NDJSON into the developer's real per-user log directory (~/Library/Logs/…) and run its
 * prune/gzip maintenance against real files. Redirecting SF_DATACLOUD_LOG_DIR to a throwaway temp
 * directory keeps the whole suite hermetic without changing any product default.
 *
 * This only sets a DEFAULT: if the env var is already set (CI, or a specific test's own override in a
 * beforeEach) that value is left untouched, so per-test control still wins.
 */
if (!process.env.SF_DATACLOUD_LOG_DIR) {
  process.env.SF_DATACLOUD_LOG_DIR = mkdtempSync(join(tmpdir(), 'dc-diag-test-'));
}
