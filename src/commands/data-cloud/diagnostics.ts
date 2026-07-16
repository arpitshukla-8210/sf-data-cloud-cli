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

import { resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { collectDiagnosticBundle, defaultOutputName } from '../../shared/services/diagnostics-service.js';
import { fileTimestamp } from '../../shared/diagnostics/storage.js';
import { DiagnosticsResult } from '../../shared/types/diagnostics.js';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-datacloud-devops', 'data-cloud.diagnostics');

/*
 * Command: sf data-cloud diagnostics
 * Bundles the LOCAL NDJSON diagnostic logs (written by the passive observer channel, plan §logger.ts)
 * into a single gzipped tar for support. This command touches no org and no wire contract — it reads
 * the on-disk log directory and packs what it finds. Stays thin: all enumeration, capping, manifest
 * building, and archiving live in the diagnostics service. The command owns only flag parsing, the
 * timestamped default output path, and the human-readable summary.
 */
export default class DataCloudDiagnostics extends SfCommand<DiagnosticsResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    days: Flags.integer({
      summary: messages.getMessage('flags.days.summary'),
      default: 3,
      min: 1,
    }),
    output: Flags.string({
      summary: messages.getMessage('flags.output.summary'),
      aliases: ['o'],
    }),
    'include-env': Flags.boolean({
      summary: messages.getMessage('flags.include-env.summary'),
      default: false,
    }),
  };

  public async run(): Promise<DiagnosticsResult> {
    const { flags } = await this.parse(DataCloudDiagnostics);

    // The command owns wall-clock concerns (the service stays pure/deterministic): stamp the default
    // output name and the manifest's generatedAt from a single `now`.
    const now = new Date();
    const outputPath = resolve(flags.output ?? defaultOutputName(fileTimestamp(now)));

    const result = await collectDiagnosticBundle({
      days: flags.days,
      outputPath,
      includeEnv: flags['include-env'],
      generatedAt: now.toISOString(),
      now,
    });

    // Human-readable output (auto-suppressed when --json is present).
    this.log(messages.getMessage('info.written', [result.outputPath]));
    this.log(messages.getMessage('info.summary', [result.fileCount, flags.days]));
    if (result.truncated) {
      this.warn(messages.getMessage('info.truncated'));
    }

    // Returned object is what --json emits and what unit tests assert against.
    return result;
  }
}
