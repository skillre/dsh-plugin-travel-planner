# Uninstall and rollback

Remove the bundle from a profile:

```sh
dsh plugin --profile <profile> remove @skillre/dsh-plugin-travel-planner
```

Roll back to a known-good version:

```sh
dsh plugin --profile <profile> remove @skillre/dsh-plugin-travel-planner
dsh plugin --profile <profile> add @skillre/dsh-plugin-travel-planner@<known-good-version>
```

Then inspect and start the profile:

```sh
dsh --profile <profile> --dump-config
dsh --profile <profile>
```

If the plugin prevents the Web GUI from starting, perform recovery from the CLI; do not depend on the GUI being available.

Removing the package removes its Bundle layer: both composed rows, every `travel_*` tool, the browser API route, and the sidebar tab.

Deliberately left behind:

- **Trip documents** at `<session workspace>/.travel/` — your data, not the plugin's. Delete that directory yourself if you want it gone.
- **The AMap container** — only a container this plugin started is stopped on disposal. A container you started is left running; stop it with `amap-gui stop`.
- **Cached CLI responses** — in memory only; a restart clears them.

The plugin writes no credential to disk, so uninstalling leaves nothing to revoke. If the AMap key was added to the DSH credential store specifically for this plugin, remove it with the ordinary credential tooling when it is no longer needed.
