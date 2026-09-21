---
'@skillre/dsh-plugin-travel-planner': minor
---

Place photos no longer need the AMap container at all: the plugin can read
provider facts over the AMap Web-service API instead of driving the CLI.

- **Why it matters.** The CLI answers queries by driving a running JSAPI
  container, and starting that container opens the AMap desktop window. 0.6.2
  stopped the sidebar from doing that on its own, but the photo still could not
  be fetched without a container. A Web-service key removes the dependency
  instead of just asking permission: `GET /v3/place/text` with
  `extensions=all` returns `photos[]` and `tel`, and `GET /v3/place/detail`
  returns one POI by id — both plain HTTPS.
- **New `amap.restKeyRef`** (default `AMAP_REST_KEY`). When it resolves, place
  fact lookups go over the Web-service API and never invoke the CLI, so opening
  a stop cannot open a window; `travel_place_refresh` and the sidebar's silent
  lookup both use it. Without it, everything falls back to the previous
  behaviour (`photoLookup: 'container'`).
- **Id first, name second.** A place that recorded `providerPlaceId` is read
  through `place/detail`, which needs no name matching — 「故宫博物院（午门入口）」
  resolves through the id it stored even though the provider calls that POI
  「故宫博物院检票处」. Only an id-less or forgotten place falls back to a keyword
  search with the same exact-name rule as before.
- **Rate limits.** Personal keys allow only a few queries per second, so calls
  are spaced (350ms) and a `CUQPS_HAS_EXCEEDED_THE_LIMIT` answer is retried
  twice before it is reported. Measured on a real trip: 10 of its 11 photo-less
  places filled over HTTPS with no CLI call and no window; the eleventh is a
  placeholder that is not a POI.
- The view now says how a photo would be fetched (`photoLookup: 'direct' |
  'container'`), so the sidebar looks a photo up immediately when the
  Web-service API can answer, and only falls back to the
  「启动高德并补全」 explanation when the CLI really is the only source.
