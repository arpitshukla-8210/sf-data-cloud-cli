# summary

List Data Cloud components filtered by type and dataspace.

# description

Returns a targeted list of metadata components currently configured within a specific Data Cloud (Data 360) dataspace that match a specified component type. Pass a component type value from "sf data-cloud component-type list".

# flags.component-type.summary

API name of the component type to filter by (for example, CalculatedInsight).

# flags.dataspace.summary

Developer name of the dataspace to scope the lookup to.

# flags.src-org.summary

Username or alias of the source org to list components from.

# examples

- List all Calculated Insights in the default dataspace:

  <%= config.bin %> <%= command.id %> --component-type CalculatedInsight --dataspace default --src-org testOrg1

- Use the command alias as an alternative:

  <%= config.bin %> data-cloud component-names --component-type CalculatedInsight --dataspace default --src-org testOrg1

# info.found

Found %s components matching type '%s' in dataspace '%s'.
