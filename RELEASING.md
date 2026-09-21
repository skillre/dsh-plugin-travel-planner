# Releasing @skillre/dsh-plugin-travel-planner

Publishing, tags, releases, Trusted Publisher changes and remote writes require direct human authorization.

## Bootstrap once

1. Enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.
2. Review branch protection: a PR created with the default `GITHUB_TOKEN` does not trigger a new `pull_request` workflow. Manually dispatch checks, prepare the version PR as a human, or use a reviewed GitHub App when a required status would otherwise be absent. Do not silently add a long-lived PAT.
3. With the pinned Node/npm baseline, run `npm run check && npm run release:prepare`, inspect it, then manually publish that exact `./release-artifact/*.tgz` with login and 2FA; never publish a fresh implicit repack and never store a token in the repository. CI later requires the registry integrity to match its deterministic artifact.
4. Configure npm Trusted Publishing for `skillre/dsh-plugin-travel-planner`, workflow `release.yml`, environment `npm-publish`.
5. Create the protected `npm-publish` GitHub Environment with a human reviewer and `main` restriction.
6. Set repository variable `NPM_TRUSTED_PUBLISHING_READY=true` only after the publisher configuration matches exactly.

## Every release

1. Include a Changeset with the feature/fix PR.
2. Update README compatibility claims and `compatibility.json` from real tarball mount evidence, then rebuild and remount the exact final tarball that contains that evidence.
3. Merge to `main`; review the Changesets version PR and CHANGELOG.
4. Merge the version PR and approve the protected publication Environment.
5. Verify npm version, tarball files, provenance, GitHub tag/release and a clean-profile install.

The workflow builds and checks the tarball in an unprivileged job and retains the immutable artifact for 14 days to allow protected-environment review. The OIDC job checks out no source, installs no project dependencies, disables package-manager caching, verifies SHA-1 and SHA-512, pins the npm registry, and runs `npm publish --ignore-scripts` on that tarball only. Stable versions use the `latest` dist-tag; SemVer prereleases use `next`. A full rerun skips publication only when npm already holds the exact same integrity. GitHub tag/release creation occurs afterward in a separate job without OIDC permission.

## Rollback

Never overwrite an npm version. Deprecate a bad version, tell users which known-good version to pin, and publish a new fix. See `UNINSTALL.md` for profile commands.
