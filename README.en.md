# @skillre/dsh-plugin-travel-planner

> Status: experimental · implemented (Host + Client); human browser pass pending

A DSH-native travel planner for solo and couple trips. It queries places and routes through the AMap CLI and presents daily itineraries, place cards, transport legs, and alerts in the DSH right Sidebar — while exposing the same capability to the model as `travel_*` tools.

[中文](README.md)

## What it does

- **Conversation-driven, structurally stored**: the model maintains one Trip Project through `travel_*` tools instead of regenerating an itinerary each turn.
- **AMap facts**: keyword and nearby POI search, walking/transit/riding/driving routes with waypoints, normalized to GCJ-02 coordinates.
- **Right-Sidebar workspace**: `itinerary / map / places / alerts`. At 1240px and wider the pane is three zones — itinerary, map, day list; 1080-1239px is two, 560-1079px puts the map above the itinerary and the day list, and anything narrower is a single column (all decided by CSS container queries, no runtime hook). The map's box is sized from the route's own shape: a whole-trip route is about square, and a 2.8:1 strip can only fit it by turning the journey into a blob. The view refits whenever that box changes.
- **Timeline**: a time rail on the left (clock plus a category-tone node on a dashed connector that runs through the following transport leg) beside a card carrying the name, the 固定 chip, dwell time and category/address, with a thumbnail and the drag handle. Alerts stay out of the cards: a day states them once, in its header. On the map every stop is a teardrop coloured by its day; a day's first stop is its anchor (`D1`…`D14`) and the rest carry their place in the day. Marker names appear from zoom 6, or whenever the view holds ten stops or fewer — thirty-two names on a country-wide map is a pile, not a map.
- **A driving day is a first-class thing.** A day can be nothing but road, with no stop at all: `TripDay.transits` records the move itself — its two ends (a place id when the library has one, a name always), the mode, distance, duration, departure and arrival clocks, the provider's own path, and where the figures came from. A transit counts towards distance and driving hours, never towards the stop count or a dwell time, and a day with transits and no stops is complete rather than empty. `travel_day_set_transit` plans the road through AMap, and the panel's 「记为转场」 promotes a distance that only existed in a day title into real data.
- **Drag to re-order with automatic re-timing**: the units being passed slide aside and the released stop eases into the slot the list opened, then the Host re-times the day from dwell and measured travel (fixed stops do not move). The panel offers 「重算这一天交通」 (real routing, no model) or an Agent review, and the 「交通待重算」 entry lives permanently in the day header, so dismissing a notice never removes it.
- **Real POI photos**: AMap photos as timeline thumbnails, a detail banner and a place-library wall, hidden on load failure; the place library can backfill missing ones by re-searching the POI (matched by POI id first, then by an exactly equal name).
- **Fixed stops and incremental edits**: a fixed stop is one the Agent will not move or re-time and the user cannot drag; anything unfixed can be dragged, retimed or removed. Every write carries `expectedRevision` (409 on conflict); `set-trip-dates` moves the whole plan to a new range and re-dates every day, with fixed items shifting alongside their day.
- **Deterministic alerts**: overlaps, missing or stale transport, overloaded days, pace, budget, and fact staleness are computed in code, never authored by the model.
- **Export**: Markdown itinerary and JSON backup.

## Install

```sh
dsh plugin --profile <profile> add @skillre/dsh-plugin-travel-planner
```

Before release, pack a tarball and install it into an isolated profile. A source link does not replace publication-view testing.

## Configuration

The bundle injects two rows. `webKeyRef` / `securityKeyRef` are DSH credential references (names), never key values:

```yaml
- id: skillre-travel-planner
  name: '@skillre/dsh-plugin-travel-planner'
  config:
    amap:
      webKeyRef: AMAP_KEY
      securityKeyRef: AMAP_SECURITY_KEY
- id: skillre-travel-planner-web
  name: '@skillre/dsh-plugin-travel-planner/web'
```

| Field | Default | Purpose |
|---|---|---|
| `workspaceSubdirectory` | `.travel` | Workspace directory holding trip projects |
| `currency` | `CNY` | Default currency for new trips |
| `timezone` | `Asia/Shanghai` | Default time zone for new trips |
| `httpPath` | `/api/skillre-travel` | Browser API prefix |
| `amap.executable` | `amap-gui` | CLI executable |
| `amap.webKeyRef` | required | Credential reference holding the AMap Web (JS API) key |
| `amap.restKeyRef` | `AMAP_REST_KEY` | Credential reference holding an AMap **Web-service** key. With it, place photo/phone lookups go straight over HTTPS and need **no AMap container at all** (nothing pops up); without it the plugin falls back to the CLI, where such a lookup needs a running container. |
| `amap.securityKeyRef` | empty | Credential reference for the security key, when the account needs one |
| `ui.placePhotos` | `auto` | Whether AMap POI photo URLs reach the browser (`auto` shows real photos, `off` keeps third-party addresses out of the client). |
| `alerts.routeStaleMode` | `adaptive` | How an expired route is graded: `adaptive` speaks up only near the day it serves (>7 days: nothing, 1–7 days: info, ≤1 day: warning); `strict` always warns. |
| `amap.browserMap` | `auto` | Whether the Sidebar renders AMap itself with the `webKeyRef` key; `off` falls back to the coordinate schematic. |
| `amap.autoStart` | `true` | Start the AMap container when it is not running |
| `amap.autoStop` | `true` | Stop only a container this plugin started |
| `amap.commandTimeoutMs` | `45000` | Per-command timeout (1000–600000) |
| `amap.poiCacheTtlMs` | `86400000` | POI cache lifetime |
| `amap.routeCacheTtlMs` | `21600000` | Route cache lifetime |

The main row owns the tools, the store, and the CLI gateway; the web row carries the browser API, so a profile without the Web GUI still gets every model tool.

## Model tools

`travel_project_create` · `travel_project_list` · `travel_project_select` · `travel_project_read` · `travel_project_patch` · `travel_place_search` · `travel_place_refresh` · `travel_route_plan` · `travel_day_rebuild_legs` · `travel_itinerary_validate` · `travel_project_export` · `travel_map_focus`

## Data location

```text
<session workspace>/.travel/projects/<tripId>/trip.json     # readable, diffable project document
<session workspace>/.travel/projects/<tripId>/exports/      # Markdown / JSON exports
```

## Security

- Starts and controls an `amap-gui` subprocess and reaches AMap network services; with `amap.restKeyRef` configured, photo/phone lookups call the AMap Web-service API over HTTPS only and need no container.
- Credentials resolve per call through the DSH `credentials` service and are injected only into that child's environment; they never reach files, logs, tool results, or command-line arguments.
- Only a container this plugin started is stopped.
- The browser API accepts same-origin requests only and reads/writes trip data only.
- No booking, payment, or cancellation.

See [SECURITY.md](SECURITY.md) and [docs/amap-cli-integration.md](docs/amap-cli-integration.md).

## Verification status

| DSH version | Result | Verified | Checks |
|---|---|---|---|
| 0.1.5-rc.2 | passed | 2026-09-15 | `dump-config`, `bounded-startup` (tarball installed into an isolated profile; both rows activated; API and boot graph verified) |
| 0.1.6-alpha.1 | passed | 2026-09-15 | the two above plus `browser` (the right-Sidebar occupant is `active: true` in the live Slot ledger; the in-panel AMap renders tiles and a marker from a loopback page origin) |

Machine-readable evidence lives in `compatibility.json`. **The human sidebar pass is still outstanding** — drag feel, the photo wall and the 固定 wording were verified structurally and through a scripted browser run, but only you can sign off on how they feel.

Contracts used and the full verification procedure: [docs/implementation.md](docs/implementation.md). The timeline, drag motion, 固定 wording, photo backfill and recompute entry are designed and measured in [docs/sidebar-v4-design.md](docs/sidebar-v4-design.md); the whole-trip layout and its map are in [docs/sidebar-v5-design.md](docs/sidebar-v5-design.md), [docs/sidebar-v6-design.md](docs/sidebar-v6-design.md) and [docs/sidebar-v7-design.md](docs/sidebar-v7-design.md).

## Known limitations

- The AMap contract does not provide opening hours, ratings or live prices (POI photos it does), and the plugin never invents them.
- Transit routes are per-city; intercity transport cannot be disguised as a local transit result.
- The in-panel map is a coordinate schematic for order and backtracking; precise road networks stay in the AMap container.
- POI photos are http URLs on AMap's CDN: they load directly from `http://127.0.0.1`, but an https Sidebar would need a Host-side image proxy (not implemented).
- Dragging works within one day; moving a stop across days goes through the Agent or `travel_project_patch`.
- Routes registered by the plugin are not covered by the Web GUI's browser-trust fence (measured: `/api` answers 401, a plugin route does not check the launch cookie). See [SECURITY.md](SECURITY.md).
- Client copy is Chinese only.
- One real browser session is still required to confirm the tab renders.

## Uninstall and rollback

See [UNINSTALL.md](UNINSTALL.md).

## License

MIT
