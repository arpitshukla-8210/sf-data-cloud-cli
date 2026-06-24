# summary

Deploy a Data Cloud component and its dependencies to a target org.

# description

Starts an asynchronous deployment of a Data Cloud component and its dependencies to the target org.

The command reads the component plus its transitive dependencies from the local data-cloud/ tree and submits them to the org. The deploy runs in the background; the call returns immediately with a submission status of SUBMITTED. Detailed per-job status tracking is not yet available.

# flags.component.summary

The component to deploy, in TYPE:NAME format (for example, CalculatedInsight:HighValueCustomers).

# flags.dataspace.summary

Developer name of the dataspace context.

# flags.target-org.summary

Username or alias of the target org to deploy to.

# examples

- Deploy a Calculated Insight component to a target org:

  <%= config.bin %> <%= command.id %> --component CalculatedInsight:HighValueCustomers --dataspace default --target-org uat-org

# info.submitted

✓ Deployment submitted for %s in dataspace %s.

# info.jobId

Job ID: %s

# info.status

Status: %s

# info.statusNote

Status tracking for this deployment is not yet available.
