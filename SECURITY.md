# Security Policy

## Reporting

Do not open a public issue for a vulnerability that exposes credentials, private data, arbitrary command execution, unsafe filesystem access, or an authentication bypass. Contact the repository owner privately through GitHub first.

## Secrets

This repository must not contain npm tokens, GitHub tokens, API keys, `.env` contents, private keys, captured login output, or user Session data. Examples use obvious placeholders only.

## What the implemented plugin touches

- **Processes**: starts and controls `amap-gui` (an Electron/AMap JSAPI container) through the DSH `subprocess` service. Arguments are passed as an argv array and never shell-interpreted.
- **Credentials**: the AMap Web key and security key are resolved per call through the DSH `credentials` service by reference name and injected only into that child process environment. They are never written to files, logs, tool results, or command-line arguments, and the plugin never caches them across operations.
- **Browser map**: the Web (JS API) key is a public value — AMap serves it to every browser that renders a map — so `GET <prefix>/state` carries it when `amap.browserMap` is `auto`, which is how the Sidebar draws AMap itself. The security key is a server-side secret and is never sent over that route; the panel issues no AMap web-service call, so it needs none. Set `amap.browserMap: 'off'` to keep even the public key out of the browser, at the cost of the schematic fallback.
- **Network**: the AMap CLI process reaches AMap services. The plugin itself opens no other connection.
- **Filesystem**: reads and writes trip documents under `<session workspace>/<workspaceSubdirectory>` (default `.travel`) through the DSH `fs` service, so the deployment's file policy applies.
- **HTTP**: registers one same-origin prefix route under the configured `httpPath` (default `/api/skillre-travel`) that serves and mutates trip data only. A request carrying an `Origin` header must match the `Host` authority, so a page on another origin cannot read or mutate trips through a visitor's browser. Measured limitation: `webServer.register` routes are matched before the Web GUI's browser-trust fence, which is enforced inside the shipped `/api` route handler rather than at the carrier, so **no plugin route inherits the launch-cookie check** — including this one, at either `/skillre-travel/api` or `/api/skillre-travel` (verified with `curl` against a live profile: `/api` → 401 with no cookie, `/api/skillre-travel/health` → 200). Any client that can reach the DSH port can therefore call this API. Keep the Web GUI bound to loopback, or put an authenticating reverse proxy in front of a non-loopback bind. The route prefix sits under `/api` so an existing `/api`-scoped front-door rule still covers it.
- **Container ownership**: the AMap container is stopped only when this plugin was the process that started it, and only when `amap.autoStop` is enabled.

Booking, payment, and cancellation are out of scope: the plugin never places an order.

## Release integrity

Normal releases use npm Trusted Publishing/OIDC from the exact `release.yml` workflow and the protected `npm-publish` GitHub Environment. An unprivileged job builds and tests the reviewed commit, uploads a SHA-1/SHA-512-recorded tarball, and the OIDC job checks out no source, installs no project dependencies, disables package caching, pins `https://registry.npmjs.org/`, verifies the artifact, and publishes it with lifecycle scripts disabled. A rerun accepts an existing version only when its registry integrity equals the verified artifact.

## Supported versions

Until the first stable release, only the latest published version receives security fixes unless a release note states otherwise.
