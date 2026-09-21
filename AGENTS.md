# AGENTS.md — dsh-plugin-travel-planner

## Repository identity

- GitHub: `skillre/dsh-plugin-travel-planner`
- npm: `@skillre/dsh-plugin-travel-planner`
- Fleet slug: `travel-planner`
- Initial DSH observation: `0.1.5-rc.2` on `2026-09-14`
- Status: experimental

This repository is an independent Git and npm release unit. Its parent fleet instructions are not automatically inherited because this repository's `.git` is the project root; this file is therefore self-contained.

## Dynamic discovery is mandatory

The repository template is only an engineering shell. It does not define the current DSH business API.

Before using any Service, Event, Builtin, Tool, Slot, Theme token, current page prop, or Host/Client bridge:

1. Load `cordis-plugin-development` when available.
2. Call `cordis_inspect_list` against the current runtime.
3. Query the exact required contract with `cordis_inspect_query`.
4. Decide Host, Client, or both from the data owner.
5. Validate uncertain behavior as a temporary creation-mode Plugin.
6. Promote verified behavior into native TypeScript and tests.

Never copy a complete API from another plugin, old README, recipe, declaration, or template. Never use Inspect output as runtime business data.

For Cordis composition or preset work, load `editing-cordis-compositions`. Never edit shipped DSH presets or the shipped installation.

## Native package constraints

- Preserve the package, repository, row, and Cordis plugin names after first public release.
- Keep the package ESM and its bundle patch at `cordis.patch.yml`.
- Ensure `package.json#dsh.bundle.patch` points to a file included by `files`; publish only built runtime/declaration files, the patch, `compatibility.json`, README/uninstall guidance, and license.
- Row IDs are fleet-global and start with `skillre-`.
- Declare only actual dependencies. Keep identity-sensitive Cordis/DSH APIs as peers when required and mirror them in devDependencies.
- Do not commit `file:`, `link:`, or `workspace:` dependency specifications.
- Standalone TypeScript relative imports use explicit `.js` specifiers unless the build configuration deliberately establishes another tested rewrite rule.
- Required Cordis services use `inject`; optional services use `ctx.get()` and handle absence.
- Every side effect must belong to the current Fiber and be removed on stop/update.
- Host↔Client boundaries carry only minimal lossless JSON.
- Do not add Client structure from memory; query the current Client contract and then add the required build/export manifest deliberately.

## Development workflow

1. Define goal, non-goals, permissions and data owner.
2. Inspect current contracts and record only the minimum used.
3. Prototype dynamically where useful.
4. Implement native TypeScript.
5. Add behavior, error and lifecycle tests.
6. Run `npm run check`.
7. Pack and install the tarball through an isolated DSH profile.
8. Update README, compatibility evidence and a Changeset.
9. Request independent review.

`link:` deployment is **forbidden**. Never install a plugin into a DSH profile by symlinking or
`link:`-ing its source directory, and never add `file:`, `link:`, or `workspace:` specs to a
manifest. A source link makes the plugin resolve its own `node_modules` instead of the host's,
which silently hides API drift between the plugin and the running DSH: everything looks green
locally while a packed install aborts the whole profile boot. Pack a tarball and install that
into an isolated profile — that is the only supported install path.

## Subagents

For independent work, prefer background subagents using `opencode-go-dsv41/deepseek-flash` at `max` effort.

- One writing agent owns this repository per wave by default.
- Parallel writers require separate Git worktrees and non-overlapping paths.
- The parent/integrator owns package exports, dependency changes, bundle composition and final verification.
- A separate read-only agent reviews the completed diff.
- Do not run concurrent installs against this lockfile.

Every handoff includes files changed, tests run, result, risks and follow-ups.

## Remote and release authority

Without a new direct human instruction, agents MUST NOT:

- push;
- open or merge pull requests;
- create tags or GitHub Releases;
- publish or deprecate npm versions;
- alter Trusted Publisher, Environment, repository protection or credentials.

Never add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `_authToken`, private keys, login output, or real secrets to any file or workflow. Follow `RELEASING.md`; release preparation must consume real `compatibility.json` evidence and keep source/dependency execution outside the OIDC job.

Lifecycle status is fleet-owned. When proposing `experimental`, `active`, `maintenance`, `deprecated`, or `archived` changes, report the requested transition to the fleet parent/maintainer so it can update `plugins.json`, npm deprecation state, README and GitHub repository state consistently; do not edit a parent checkout implicitly.

## Verification

During implementation:

```sh
npm run typecheck
npm test
```

Before review:

```sh
npm run check
```

Before release, additionally verify the generated tarball in a fresh DSH profile with `--dump-config` and a bounded real startup. UI changes require a real browser check against the existing DSH Web application.

Compatibility claims are based on real mount tests, not peer-range satisfaction alone. Record the exact DSH version and verification date in `compatibility.json` and README.
