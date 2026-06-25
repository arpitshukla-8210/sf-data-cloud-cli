# summary

Check the status of an asynchronous Data Cloud deployment job.

# description

Polls the status of an asynchronous Data Cloud deployment job on the target org.

The command reports the overall job status and a per-component breakdown. A completed job reports SUCCEEDED; an in-progress job reports INPROGRESS; a failed job reports each failing component and the reason it failed.

# flags.job-id.summary

The tracking job ID returned by the initial deployment request.

# flags.target-org.summary

Username or alias of the destination org.

# examples

- Check the status of a deployment job:

  <%= config.bin %> <%= command.id %> --job-id 08PVF000002iQIb --target-org uat-org

# info.jobId

Job ID: %s

# info.status

Status: %s

# error.header

Error details for component '%s':

# error.reason

Reason: %s
