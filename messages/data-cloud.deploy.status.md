# summary

Check the status of an asynchronous Data Cloud deployment job.

# description

Polls the tracking status of a specific background Data Cloud deployment job on the target org.

This command currently returns dummy data and does not contact an org. Pass the job ID returned by "sf data-cloud deploy". A successful job reports SUCCEEDED; a failed job reports the failing component and the reason.

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
