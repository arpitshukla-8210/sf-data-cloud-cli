# summary

Retrieve a Data Cloud component along with its full dependency graph.

# description

Pulls a metadata component from a source org along with all necessary internal engine dependencies. It writes one JSON file per component to the local data-cloud/ directory, along with a manifest of the deployment order.

# flags.component.summary

The component to retrieve, in TYPE:NAME format (for example, CalculatedInsight:highValueCustomer).

# flags.dataspace.summary

Developer name of the dataspace context. Optional; if omitted, the org's default dataspace context is used and components are written to the data-cloud/ root.

# flags.src-org.summary

Username or alias of the source org.

# examples

- Retrieve a Calculated Insight component from a source environment:

  <%= config.bin %> <%= command.id %> --component CalculatedInsight:highValueCustomer --dataspace default --src-org testOrg1

# info.success

✓ Retrieved %s components (full dependency graph):

# info.componentLine

%s:%s

# info.filesWritten

Files written to %s
