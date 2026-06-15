# summary

List the Data Cloud component types supported for retrieve and deploy.

# description

Returns the catalog of Data Cloud (Data 360) component types that the DevOps retrieve and deploy commands support. The key is the component type value you pass to other sf data-cloud commands; the value is its display label.

# flags.src-org.summary

Username or alias of the source org to list component types from.

# examples

- List all supported component types:

  <%= config.bin %> <%= command.id %> --src-org testOrg1

- Get the result as JSON (useful for scripts and agents):

  <%= config.bin %> <%= command.id %> --src-org testOrg1 --json

# info.found

Found %s supported component types.
