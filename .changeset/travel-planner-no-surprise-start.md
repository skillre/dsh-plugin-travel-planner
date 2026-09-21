---
'@skillre/dsh-plugin-travel-planner': patch
---

Photo lookups no longer open the AMap desktop window on their own.

- **Why it happened.** The AMap CLI answers queries by driving a running JSAPI
  container, so `AmapGateway.ensureReady` starts that container whenever it is
  down — and starting it opens the AMap window. Every uncached lookup went
  through `ensureReady`, including the photo lookup a detail card fires when it
  is opened, so clicking a stop could raise a desktop window as a side effect of
  a nicety.
- **The rule now.** Starting the container is something a caller must ask for:
  `ensureReady(signal, { allowStart })` defaults to allowing it (tools, route
  planning, map focus — explicit actions), while the sidebar's silent photo
  lookup passes `allowStart: false`. A cold container then answers with a new
  stable code `AMAP_NOT_RUNNING` instead of starting anything, `POST
  /refresh-places` reports `needsStart: true` in its body, and the detail card
  offers 「启动高德并补全」 — a button that says it opens the AMap window — in
  place of the background request. The header's bulk offer switches its label to
  「缺 N 张照片 · 启动高德并补全」 for the same reason.
- The client only auto-looks-up a photo when `/state` reports the container
  running and the map ready, so the silent path can never have that side effect.
