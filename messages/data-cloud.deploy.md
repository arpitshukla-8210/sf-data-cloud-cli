# summary

Deploy a Data Cloud component and its dependencies to a target org.

# description

Starts an asynchronous deployment of a Data Cloud component to the target org and returns a job ID you can poll for status.

This command currently returns dummy data and does not contact an org. The deploy runs in the background; the call returns immediately with a job ID in the CREATED state. Track progress with "sf data-cloud deploy status".

# flags.component.summary

The component to deploy, in TYPE:NAME format (for example, CalculatedInsight:HighValueCustomers).

# flags.dataspace.summary

Developer name of the dataspace context.

# flags.target-org.summary

Username or alias of the target org to deploy to.

# examples

- Deploy a Calculated Insight component to a target org:

  <%= config.bin %> <%= command.id %> --component CalculatedInsight:HighValueCustomers --dataspace default --target-org uat-org

# info.started

✓ Deployment started for %s in dataspace %s.

# info.jobId

Job ID: %s

# info.status

Status: %s

# info.pollHint

Track progress with: sf data-cloud deploy status --job-id %s --target-org %s
