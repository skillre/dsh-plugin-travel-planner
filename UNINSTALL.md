# Uninstall and rollback

In your DSH Desktop Client or Web UI **Plugins** manager, select `@skillre/dsh-plugin-travel-planner` and confirm removal. To roll back, you choose a compatible known-good version from a supported, verified source in that manager, remove the faulty version and install/enable the replacement, if supported; restart when requested and check the result. Developers/agents do not remove preexisting user plugins, install replacements or edit the user's profile for them.

Temporary developer installs must use an owned disposable **non-Desktop** profile: stop the test process, remove only test-created bundle/dependency/selection/config state or the confirmed owned profile, and verify cleanup even after failure. A real Desktop/Web user-profile test requires prior consent, baseline inventory and a reversible plan; restore only test-created changes, preserving preexisting installations and data. If the manager cannot start, arrange separately authorized CLI/profile recovery; do not assume CLI `--profile desktop` can operate on Electron's managed `desktop` profile.

Removing the package removes its Bundle layer: both composed rows, every `travel_*` tool, the browser API route, and the sidebar tab.

Deliberately left behind:

- **Trip documents** at `<session workspace>/.travel/` — your data, not the plugin's. Delete that directory yourself if you want it gone.
- **The AMap container** — only a container this plugin started is stopped on disposal. A container you started is left running; stop it with `amap-gui stop`.
- **Cached CLI responses** — in memory only; a restart clears them.

The plugin writes no credential to disk, so uninstalling leaves nothing to revoke. If the AMap key was added to the DSH credential store specifically for this plugin, remove it with the ordinary credential tooling when it is no longer needed.
