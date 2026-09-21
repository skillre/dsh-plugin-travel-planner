# Changelog

## 0.5.0

> 0.1.0 – 0.4.0 是本机验证构建，从未发布到 npm；它们的变更集在此一并结算，
> 因此这一条覆盖到 0.5.0 为止的全部内容。

### Minor Changes

- Hand re-ordering with automatic re-timing, real POI photos, and the visual
  pass. This completes `docs/sidebar-v3-design.md`.
  
  - **Drag to re-order.** Every stop carries a drag handle; dragging shows a drop
    line, scrolls the list at the edges, and commits on release with an optimistic
    update that rolls back on failure. Locked stops cannot be dragged (their handle
    says so), and `⌥↑` / `⌥↓` moves the focused stop without a pointer. The detail
    sheet no longer carries 上移/下移 buttons.
  - **The clock follows.** New pure `domain/reflow.ts` re-times a day from three
    facts: the day's own start clock, each stop's dwell time, and the travel
    between consecutive stops. A locked stop keeps the times the user pinned and
    re-anchors everything after it. Stored legs are re-derived for the new order:
    a pair that was measured keeps its numbers but is flagged `stale`, and a pair
    that was never measured gets no invented leg, so `MISSING_ROUTE` tells the
    truth instead of hiding behind a guess. Re-timing a day in place leaves its
    legs untouched, and re-timing an already re-timed day changes nothing.
  - **Two ways to make the estimate real.** New `POST <prefix>/rebuild-legs` runs
    the AMap CLI for the day — the same implementation the `travel_day_rebuild_legs`
    tool now delegates to — and `POST <prefix>/reflow-day` applies a re-order plus
    its re-timing in one revision. After a drag the panel offers 「重算这一天交通」
    (no model, real routing) and 「让 Agent 复核」 (seeds an editable instruction).
  - **Real POI photos.** `photo` was always in the AMap POI response and was being
    dropped; it is now normalized onto the place and shown as a thumbnail per stop,
    a banner in the detail sheet, and a photo wall in the place library. Images
    that fail to load disappear instead of leaving a broken box, and
    `ui.placePhotos: 'off'` keeps the third-party URLs out of the client entirely.
  - **Visual pass (direction A+C).** Every stop gets a category colour band and a
    reserved thumbnail column so rows stay in line; the day header is a chapter bar;
    the readiness ring, drag handle and detail actions were re-tuned.
- Implement the travel planner described by the three design documents.
  
  Host: Trip Project store under `<workspace>/.travel`, revision-checked and
  lock-protected patches, deterministic validation with alerts and readiness,
  a serialized AMap CLI gateway (lifecycle, timeout, cancellation, cache, error
  codes), nine `travel_*` model tools, Markdown/JSON export, and a same-origin
  browser JSON API.
  
  Client: a `skillre-travel` right-Sidebar page tab with itinerary, map, places
  and alerts views, narrow and fullscreen presentations, lock toggles, and a
  coordinate schematic map.
  
  Composition: the bundle now injects two rows — `skillre-travel-planner` for the
  tools/store/gateway capability and `skillre-travel-planner-web` for the browser
  API, because loader rows apply in parallel and the web carrier must wait for the
  live `webServer` service.
  
  Verified with `dump-config` and a bounded real startup in an isolated profile;
  the human browser pass is still pending and is therefore not claimed.
- Map readability, explainable numbers, and an alert model that only speaks up
  when it matters. Design: `docs/sidebar-v3-design.md`.
  
  - **Markers.** Day stops are coloured pins with a pointer tip at the real
    coordinate instead of 22px pale circles; the first and last stop read 起/终
    rather than 1 and 5; the selected pin scales up with a halo and the map is
    fit, not re-created. A legend appears once more than one day is drawn.
  - **Map size.** The fixed 168px strip becomes three tiers (compact 168 /
    comfortable 260 / full-pane), a size button, and a drag grip on the card's
    bottom edge. The choice is remembered in `localStorage`, never in the
    versioned trip document. The full-pane tier keeps the day's stops as a
    scrollable chip strip along the bottom.
  - **Whole-trip view.** A `当天 / 全程` switch draws every day at once, one line
    per day in a per-day colour, with a matching legend.
  - **Explainable numbers.** The readiness ring is now a button that opens its own
    formula, the current counts, and why an `info` note does not move the score;
    the overflow menu explains each entry in a second line.
  - **Alert model.** `ROUTE_STALE` is graded against the day it serves
    (`alerts.routeStaleMode`, default `adaptive`): more than a week out it is not
    raised at all, within a week it is an `info`, and within a day — or while
    travelling — a `warning`; `strict` keeps the old always-warn behaviour. A
    day's expired routes collapse into one alert instead of one per leg, and each
    alert now carries a plain-language label, what it means, and a button that
    seeds an editable instruction for the Agent through the slot's `inputActions`
    (`setDraft`, never `submit`). A two-week-out plan no longer loses most of its
    readiness score to routes that would expire again before departure.
- Right-Sidebar v2: an inline AMap map, explicit multi-trip selection, and a
  layout rebuilt on DSH theme tokens. Design: `docs/sidebar-v2-design.md`.
  
  - **Inline map.** The panel loads the AMap JS API itself and draws the day's
    stops as numbered markers in visit order, linked to the timeline. The host
    hands over only the Web (JS API) key, read from `amap.webKeyRef`; the security
    key never leaves the process. New `amap.browserMap: 'auto' | 'off'` (default
    `auto`) keeps the key server-side when set to `off`. Failures degrade to the
    coordinate schematic with an actionable message, and a rejected promise is no
    longer cached so Retry can succeed.
  - **Multi-trip workspaces.** `.travel/state.json` records a per-session choice
    and a workspace default; resolution is explicit id → session → workspace →
    most recently updated, so a workspace that never recorded a choice behaves
    exactly as before. New `travel_project_list` and `travel_project_select`
    tools, a `POST <prefix>/select` route, and a trip switcher in the panel
    header. `travel_project_create` selects what it created.
  - **Layout.** The four-segment tab strip is gone: the map is always visible, the
    day pager replaces the day strip, the selected place opens as a bottom sheet,
    and the place library and alerts moved behind an overflow menu. Every surface,
    border and label colour now comes from a `--dsw-*` theme token, with a
    13/12/11 type scale and a readiness ring.
  - **Store.** `persist`, `exportTrip` and `storeAlerts` now take the session so
    they write to the session's workspace instead of the process fallback
    directory, which is what produced a second stray `.travel` tree.
- The timeline rebuilt around a time rail, a drag that lands instead of snapping,
  「固定」 in place of the unexplained 「锁定」, on-demand photo backfill, and a
  recompute entry that survives dismissal. See `docs/sidebar-v4-design.md`.
  
  - **Timeline.** Each stop is now a time rail (clock + category-tone node on a
    dashed connector that runs through the following transport leg) beside a card
    carrying the name, the 固定 chip, the dwell time, the category/address line and
    the worst alert, with a 42px thumbnail and the drag handle. The wide-pane day
    rail keeps its own `.trv-rail`, so the stop rail is `.trv-tick`.
  - **Drag motion.** The old flow cleared its preview before the Host answered,
    read live (sliding) rectangles for the drop index, set state on every
    `pointermove`, and had no transition — hence the jump-back-then-re-sort feel.
    Now: geometry is snapshotted once at drag start, updates are batched to one
    per animation frame, the units being passed slide with a 180ms ease, the
    released stop eases into the slot the list opened (measured from the snapshot,
    not wherever the hand stopped), and the preview is dropped in the very frame
    the new order arrives with transitions off, so nothing moves on screen. A
    2.5s guard releases the preview if the reorder never comes back.
  - **「固定」.** A stop that the Agent must not move or re-time is now called
    固定 everywhere it is visible: the row chip, both handle tooltips, the detail
    sheet button (固定 / 取消固定) with a one-line explanation, and the place
    library grouping. Place statuses in the photo wall now use their own label
    function — `locked` / `candidate` / `excluded` were rendering as 「已归档」.
    Fixed stops stay non-draggable: they are time anchors in `reflowDay`, and
    dragging one past another would publish a self-contradicting clock.
  - **Photo backfill.** New `POST /refresh-places` and model tool
    `travel_place_refresh` re-look-up every place without a photo in the trip's
    city, matching by stored POI id first and by an exactly equal name second,
    reporting the rest as `unmatched` rather than guessing. The place library
    offers 「补全照片」 while photos are missing and reports what it did.
  - **Recompute stays reachable.** The day header carries a permanent
    「交通待重算」 chip whenever the day has stale, failed or missing transport,
    opening a transport sheet with 「用高德重算这一天」 and 「让 Agent 复核」. The
    banner after a drag is now only a nudge — its 「稍后」 dismisses the banner, not
    the ability to recompute.
  - The screenshot harness now injects the exported `STYLES` verbatim instead of
    scraping the server-rendered `<style>`, which HTML-escaping had silently
    reduced to a stylesheet without any `content` rule.

### Patch Changes

- Fix the AMap CLI response layout, add trip-date editing, and stop the
  right-Sidebar panel from abdicating its slot.
  
  - `parseSearchPoi` and `parseRoute` now read `amap-gui` 0.1.1's live layout, in
    which the echoed request parameters moved into `data.state` and the match
    count is `state.resultCount`. Both parsers still accept the legacy top-level
    layout, so `travel_place_search` and `travel_day_rebuild_legs` work again.
  - New `set-trip-dates` patch op: moves the whole plan to a new date range,
    re-dates the days in order and rewrites each item's date prefix while keeping
    its time of day. Locked items shift with their day; an explicit `endDate`
    that disagrees with the day count is rejected instead of persisting a header
    that contradicts its days.
  - The tab body no longer calls the slot's `useTabInfo` selector hook with no
    selector. That call threw during render, the slot framework marked the entry
    abdicated, and the pane rendered nothing. The two-column presentation is now
    a CSS container query on the pane's own width.
  - The browser API default moved from `/skillre-travel/api` to
    `/api/skillre-travel`, so an `/api`-scoped front-door rule covers it.
    `SECURITY.md` now records the measured limitation: `webServer.register`
    routes are matched before the Web GUI's browser-trust fence, so no plugin
    route inherits the launch-cookie check at either prefix.
- Fix third-party map chrome painting over the panel, and stop an alert action
  from doubling its own prefix.
  
  - The map card now opens its own stacking context (`isolation: isolate`). AMap
    injects its logo and copyright into the container with a very high `z-index`
    on a positioned element, and because the card was not a stacking context those
    children competed directly with the panel's own layers: the logo rendered on
    top of 「提醒与冲突」 and covered the last alert's buttons. Every panel surface
    is now ordered explicitly above the map (sheets and the overflow menu 12, the
    full-pane overlay 20, the full-height map card 9). Verified with a browser hit
    test: with the card isolated the overlay is the top element at the logo's
    position, and with the isolation removed the logo wins again, reproducing the
    reported screenshot.
  - The alert action button read 「让 Agent 让 Agent 精简这一天」: `ALERT_INFO.clear`
    already carried the prefix while the button added its own. Actions are now bare
    verb phrases, and the seeded instruction reads 「请精简这一天。原因是…」 with a
    standing line asking the Agent to recompute real transport and retime the day,
    leaving locked items alone.

This file is maintained by Changesets. The generated project shell has not been released.
