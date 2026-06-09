# summary

List the Data Cloud component types supported for retrieve and deploy.

# description

Returns the catalog of Data Cloud (Data 360) component types that the DevOps retrieve and deploy commands support. The key is the component type value you pass to other sf data-cloud commands; the value is its display label.

This command currently returns dummy data and does not contact an org.

# examples

- List all supported component types:

  <%= config.bin %> <%= command.id %>

- Get the result as JSON (useful for scripts and agents):

  <%= config.bin %> <%= command.id %> --json

# info.found

Found %s supported component types.
