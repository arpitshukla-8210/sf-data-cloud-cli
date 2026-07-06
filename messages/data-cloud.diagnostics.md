# summary

Bundle local Data Cloud DevOps diagnostic logs into a shareable archive.

# description

Collects the local diagnostic log files this plugin writes on your machine and packs them into a single gzipped tar archive you can attach to a support request.

The plugin records structured, on-disk diagnostic logs for each command it runs (deploy, retrieve, deploy status). Secrets are redacted and absolute paths are scrubbed to '~' when the logs are written, so the resulting archive is safe to share. Use SF_DATACLOUD_LOG_LEVEL to raise verbosity (INFO by default; DEBUG or TRACE for more detail) before reproducing an issue, then run this command to collect the results.

The archive contains a `logs/` directory with the collected NDJSON files and a `manifest.json` index. Pass --include-env to also add an `environment.json` with non-sensitive runtime details (plugin, Node, and OS versions plus allowlisted log-configuration variables).

# flags.days.summary

Include diagnostic log files modified within this many days.

# flags.output.summary

Path to write the archive to; defaults to a timestamped file in the current directory.

# flags.include-env.summary

Include non-sensitive environment details (plugin, Node, and OS versions) in the archive.

# examples

- Bundle the last 3 days of diagnostic logs into a timestamped archive:

  <%= config.bin %> <%= command.id %>

- Bundle the last 7 days, including environment details, to a specific file:

  <%= config.bin %> <%= command.id %> --days 7 --include-env --output ./datacloud-diag.tar.gz

# info.written

Wrote diagnostic bundle to %s

# info.summary

Included %s log file(s) from the last %s day(s).

# info.truncated

The diagnostic logs exceeded the size limit; the bundle contains the most recent files only.
