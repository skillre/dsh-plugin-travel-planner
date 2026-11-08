# Changelog

## 0.14.0

### Minor Changes

- The bundled skill gains a design manual, and three promises it was quietly
  making get corrected.
  
  - **New reference — `skills/travel-planner/references/trip-design.md`.** The
    skill knew how to *operate* the tools; it did not know how to *design* a day.
    This adds the missing layer: five day shapes (arrival / full / moving /
    departure / rest) with the three questions that pick one, a five-step cut
    ladder for when the day is over-full, ordering rules (anchor segmentation, a
    non-self-intersecting loop check, when "far first" actually applies), an
    energy curve with numbers (`≥120 min` anchors at most two and never adjacent;
    `≤3.5 h` continuous on foot; never three hard days in a row), a tie-break
    order plus a fixed four-column way to present a must-see collision, a backup
    pool with a **swap-invariance test** so replacing a stop does not reshuffle
    the day, a nine-question design audit kept separate from the deterministic
    alerts, and a booking list with per-row deadlines.
  - **The skill now states what the plugin does *not* enforce.** `avoid`,
    `interests` and `maximumWalkingMinutesPerLeg` are accepted by
    `set-preferences` but nothing in the plugin ever reads them — no alert, no
    reflow, no effect on search. Only `pace` (under `relaxed`) and
    `preferredModes[0]` change behaviour. Delivery wording is tightened
    accordingly: "I designed it this way", never "the plugin enforces this".
    Same note added to `patch-ops.md`.
  - **Also corrected:** same-day lock/title ordering (`set-day-title` before
    `set-item-lock`, or the day rejects the title); the companion-composition
    question is now three decidable questions instead of the adjective list;
    elderly companionship and child/discount fare multipliers in the budget
    section, with source levels marked.
  - **Not added, on purpose:** real-time weather integration, any model-memory
    fact table, accessibility geometry, altitude medication, and the traveller
    profiles (couples/solo/business) whose "rules" would have been stereotypes
    rather than decidable criteria.

## 0.13.0

### Minor Changes

- 6925537: The itinerary is one continuous scroll of the whole trip instead of one day at
  a time, with the plan and its clock in the same row. Implements
  `docs/sidebar-v5-design.md`.
  
  - **One scroll, sticky days.** Every day is a section of a single scrolling
    itinerary; each day's head sticks to the top of the pane and carries the day's
    own numbers (`行驶 12 小时 38 分 · 1077.1 km · 2 站 · 1/14`). The pager is gone —
    a fourteen-day trip is scrolled, not clicked through fourteen times. A scroll
    spy keeps the day rail and the map on the day being read.
  - **Cross-day hops have their own row.** A driving trip states its distance in
    the day's title (`西安 → 成都｜翻秦岭 723km`) and often records no leg for it,
    which is why the itinerary used to jump silently between cities. Each boundary
    now carries a transfer row. The title decides *whether* the trip hopped; a
    recorded leg supplies the numbers only when its distance agrees with the title
    within 35%, because rebuilt legs can be placeholders (1 m) or belong to another
    part of the trip. A row shows `里程来自当天标题` when that is all there is, and
    offers 「补上时长」; a day spent inside one city renders no row at all.
  - **The day rail is a table of contents.** Each row shows its date, a bar scaled
    to the trip's busiest day, and `1077.1 km` / `未记录` / `市内`; the current day is
    highlighted and clicking one scrolls to it. Two weeks of driving read as a
    rhythm: long bars are long days, and the gaps are the stays.
  - **The map follows the itinerary.** In whole-trip mode the current day stays
    fully drawn while the rest fade back, and 「聚焦当前天」 zooms to it. The map only
    refits when what is drawn changes, so scrolling no longer yanks the view.
  - **Post-midnight clocks say so.** A stop whose clock lands after midnight (a
    12-hour drive arriving at 00:30) is labelled `次日 00:30` instead of looking
    like time running backwards.
- 6925537: The detail panel stops covering the timeline, and a stop's photo is fetched on
  demand instead of waiting for a manual sweep.
  
  - **Docked detail panel.** The place detail used to be an overlay pinned to the
    bottom-right of the pane: it covered the very rows it described, always had the
    same size, and could not be resized. It is now part of the pane's layout — a
    bottom panel while the pane is narrow, a right-hand column once the pane is
    wider than 560px — with a drag handle on its inner edge. The chosen size is
    remembered per browser (`skillre-travel:ui`), and CSS clamps it so a stored
    value can never eat the whole pane. Because the body no longer scrolls as one
    block, the timeline owns its own scroll container, which also makes the
    edge auto-scroll during a drag actually work.
  - **Photos on demand.** Opening a stop that has no photo now asks the Host for
    that one place (`POST <prefix>/refresh-places` with `placeId`, or the
    `travel_place_refresh` tool with `placeId`), so a detail card fills in as soon
    as the CLI answers instead of showing an empty space. Failures report the CLI
    message and offer 「再查一次」 rather than silently retrying. The header meta
    row also carries 「缺 N 张照片 · 补全」 for the whole library, which is what the
    timeline thumbnails need.
  - The view now states whether photos may be projected at all (`photos`), so
    `ui.placePhotos: 'off'` costs no provider calls and shows no photo surface.
  - The 固定 explanation no longer prints a paragraph under the buttons: the
    meaning lives in the button's tooltip, and the buttons keep the row to
    themselves.
- Driving days show their road on the map, and one click plans the ones that are
  still only a line of text. Implements `docs/drive-routes-design.md`.
  
  - **The gap.** A day spent driving drew the same thin dashed line as a 300 m hop
    between two temples: the whole-trip map gave a 1,077 km highway and a walk
    around the corner identical treatment, and no distance or duration was on it. A
    day whose ends were only city names drew nothing at all, and opening such a day
    on its own — the 当天 view — showed a single marker and no route, because a line
    needs two points and the day had one.
  - **Four sources, in order.** Each day now yields its road from the best thing
    known about it: the provider's own path when a transit has been planned (solid,
    labelled with the real kilometres and hours), a measured leg that dominates the
    day (solid), the day title's `西安 → 成都｜723km` between the neighbouring days'
    stops (long-dashed, `≈723 km · 按标题估算`), or nothing. None of them requires a
    place to be arranged on that day.
  - **It reads as a road.** Planned roads are solid and heavier than the stop-order
    dashes; estimated ones are long-dashed; both are labelled at their midpoint with
    mode, distance and duration, and a transit's own ends are marked with a square
    (an estimated road borrows stops that are already drawn, so it adds no marker).
    The map card says which is which: 「点位为真实坐标 · 细虚线=当天顺序 · 实线=已规划路线 · 长虚线=按标题估算」.
  - **One click to make it real.** A day whose road exists only in its title now
    offers 「补全 N 天路线」 on the map card: one request to the new
    `POST <prefix>/fill-transits` plans every such day through the Web-service
    driving API (the CLI when no key is configured, never a container that would
    open a window on the desktop) and writes the results back as transits with their
    provider path. Days that already carry a planned transit are skipped, so the
    call is cheap to repeat.
  - **Ends that are only names.** `TransitEnd` gained an optional `point`: an end
    that is not a library place can now carry the coordinate of a geocoded city
    centre (`/v3/geocode/geo`, Web service only), so a trip whose days are written
    as bare city names still draws its roads instead of nothing.
  - **Also fixed:** `buildGroups` no longer drops a day that has no located stop but
    does have a drawable road, so such a day is drawn, fitted, and reachable through
    「聚焦当前天」.
- 6925537: Place photos no longer need the AMap container at all: the plugin can read
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
- 6925537: The whole-trip map gets a box it can actually fit into, and the panel stops
  repeating itself. Implements `docs/sidebar-v7-design.md`.
  
  - **The map was the box, not the fit.** A whole-trip route is about as tall as it
    is wide — this trip spans 16.3° of longitude and 15.1° of latitude, 0.92:1 once
    projected — while the box it was fitted into was 593×205, i.e. 2.8:1. Fitting a
    square route into a letterbox forces the zoom out until the journey is a blob:
    predicted 82° of visible longitude, measured ~90° on the live pane, which is
    why the map ran from Iran to Japan. Past 1240px the panel is three zones now —
    itinerary, map, day list — and the map fills the height of its own column:
    measured at 1326px, 492×684, an aspect of 0.72:1.
  - **The layout is a grid.** The wrapping flex row let the map's capped width pull
    the itinerary onto its line, collapsing it to a 156px sliver and leaving the
    trip un-scrollable; both are measured at 900px and both are fixed.
  - **One label per day on the whole-trip map.** Stop numbers restarted at 1 on
    every day, so fourteen days of pins read 1, 2, 3 — a dozen overlapping copies
    of the same three digits. A day is now named once, at its first stop (`D1`…
    `D14`), its other stops are dots, and the in-map legend is gone: it covered the
    AMap attribution and repeated the day list, which carries each day's colour
    instead.
  - **The map refits when its box changes.** A `ResizeObserver` feeds the canvas
    size into the fit key and `resizeEnable` handles the canvas, so a pane drag or
    a layout switch cannot leave a fit measured against the old box; 「⟲ 重置视图」
    refits by hand.
  - **The day list finally reads in columns.** Every row has its date, its colour,
    its distance right-aligned in tabular figures, and a badge cell — including the
    rows that have nothing to warn about, which used to render a bar with no label
    at all and look broken. The bar is measured in the same kilometres the row
    prints, so a day whose hop exists only in its title shows `≈723 km` instead of
    an empty row.
  - **Fourteen days, fourteen colours.** The theme exposes five usable colours and
    `index % 5` gave D1, D6 and D11 the same blue, which a two-week trip drew three
    times over. Each further lap through the palette is now blended toward white,
    then toward black. The map names a day once, at its first stop, and colours it
    by the day's position in the trip — the same index the day list beside it uses,
    so a day the map cannot draw (no coordinates) no longer shifts every other
    colour and label.
  - **The itinerary stops repeating itself.** One alert per day is shown once, in
    the day header (the Host's day-level alert carries every affected stop's id, so
    attaching it per stop printed the same sentence on four cards); a cross-day row
    no longer reprints the cities and distance its own header already states, and
    says `跨城交通未记录 · 里程按当天标题估算` with the action beside the text; the
    header's numbers line no longer begins with a stray `·`; and a title that
    already states a distance no longer has it printed again underneath.
  - **Words and sizes.** `里程来自当天标题` → `按标题估算`, `待重算` → `路线待更新`,
    `交通待重算` → `重算交通`, `补上时长` → `补时长`; the clock gutter widens to 64px so
    `次日` sits above the time instead of wrapping it, and thumbnails grow from 42px
    to 64px so a 620px card is no longer mostly empty.
- The plugin now carries its own agent skill, so a profile that mounts it also gets
  the operating manual for driving it.
  
  - **What it is.** `skills/travel-planner/` is a Chinese skill bundle — a
    `SKILL.md` with the working loop, the lock and revision rules, the leg-versus-
    transit decision, and what the AMap contract does *not* know, plus five
    references (`tools`, `patch-ops`, `alerts`, `data-model`, `itinerary-craft`)
    that are loaded only when the task calls for them.
  - **How it arrives.** The row registers the bundle through the skill registry at
    apply time (`ctx.skills.register`), labelled `bundled` with the skill directory
    as its resource base, so the model can read `references/*.md` with its ordinary
    file tools. A profile without a skill registry still mounts exactly as before:
    the lookup is optional and the whole registration is a soft failure.
  - **Why it is not just prose.** It is written against the code, not the README:
    13 tools (not 12), 23 patch kinds (not the 18 in the tool description), the
    `relaxed`-only pace ceiling, the 10-hour overload line that includes transit
    time, the fact that `add-item`/`move-item` never reschedule and only
    `reflow-day`/`reorder-day` do, and that a locked item also freezes the day it
    sits on.
  - **Also.** `package.json#files` now ships the `skills/travel-planner/` directory;
    the `skills/.build/` scratch used while writing it is not packaged.
- 6925537: A day can be nothing but road. Transits are a first-class part of the trip, so a
  1,077 km drive no longer has to be faked with a place. Implements
  `docs/transit-days-design.md`.
  
  - **The gap.** `TripDay` held stops and the legs between them, so the only way to
    put "today we drive from Beijing to Xi'an" on a day was to invent a stop for
    it. On the user's own 14-day trip that produced: five days whose title states a
    distance with no leg to match (so the panel guessed from the title), five days
    with a repeated place serving only as an anchor (one day listed the same place
    three times), departure points, arrival points and a railway station counted as
    「站」, and a `DAY_OVERLOADED` warning telling a 12.6-hour drive to 「减少一个安排」.
  - **`TripDay.transits`.** A transit is the move itself: `from` and `to` (a place
    id when the library has one, a name always), mode, distance, duration, the
    clocks, the provider's path, and where the figures came from. It is not a stop:
    it counts towards distance and driving hours, never towards the stop count,
    dwell time or a stop card's visit semantics. A day with transits and no stops is
    a complete day.
  - **Rules that follow.** `EMPTY_DAY` now means "no stops **and** no transit";
    `MISSING_TRANSIT` (info) marks a title that claims a journey nothing records —
    the state the panel showed as 「跨城交通未记录」, now machine-readable too; a day
    whose time is mostly one drive is graded as 「在路上约 12.6 小时，单日驾驶偏长」 with
    「中途加一晚住宿」 instead of advice meant for an over-booked sightseeing day;
    transits are graded for staleness and failure exactly like legs, one alert per
    day for both.
  - **How they are created.** `travel_day_set_transit` plans the road (the
    Web-service driving API when a key is configured, so the map gets the real path;
    the CLI otherwise) and writes it with a provider stamp. `travel_project_patch`
    gains `set-day-transit` and `remove-day-transit`. The panel's existing
    「跨城交通未记录」 row becomes 「记为转场」 — one patch, no model — and the day then
    offers 「用高德重算」 to make the estimate real.
  - **In the panel.** A transit renders as its own card between the day header and
    its stops: `西安 → 成都`, `723 km`, the departure and arrival clocks, an estimate
    chip when nothing has planned it, and the two actions. The header says 「转场」,
    the day list's distance includes the road, and on the map the transit is drawn
    as a solid line — the provider's own path when there is one — with its unvisited
    end marked by a square rather than a stop's teardrop.
  - **Compatibility.** `schemaVersion` 2; a version-1 file still loads unchanged and
    is only rewritten at the new version when something writes to it. The panel
    tolerates a view from a Host that predates the field, so a page reloaded against
    an un-restarted Host keeps working.
- 6925537: The panel now lays itself out by width: a readable itinerary beside a companion
  column that keeps the map in view. Implements `docs/sidebar-v6-design.md`.
  
  - **A wide pane is two zones.** Past 1080px the itinerary stops stretching — it
    is capped at a 760px reading measure instead of running the full width of a
    maximised window (a 1332px pane was drawing 1150px cards, with the name at one
    edge and the dwell time a screen away). The map and the day list move into a
    companion column beside it, so scrolling the trip no longer scrolls the map out
    of sight: measured at 1332px, the map's position is unchanged after scrolling
    half the trip.
  - **Narrow panes are untouched.** Below 1080px the companion column dissolves
    (`display: contents`) and the map is the full-width banner it has always been;
    below 560px nothing changes at all.
  - **The day head is two lines.** The first says which day and which journey
    (`D1 · 09-24 周四 北京 → 西安｜赶路 1,077km`); the second carries only numbers and
    actions (`行驶 12 小时 38 分 · 1077.1 km · 2 站` … `交通待重算` `3 提醒`). The `1/14`
    counter is gone — the day list already says where you are.
  - **The day list says less, because the head says more.** A day that changes city
    without a recorded hop gets a warning dot with a tooltip instead of the words
    「未记录」, and no longer contradicts itself by also reading 「市内」.

### Patch Changes

- 6925537: Every AMap CLI call cost the full command timeout, which is what made a photo
  look like it never loaded; the detail is a floating window again.
  
  - **The CLI latency bug.** `createSubprocessExec` built its timeout budget and
    then awaited it in a `finally` block, so a call that finished in milliseconds
    still returned only when the timer fired — 45 s by default. Every uncached
    lookup paid it once per CLI invocation: a single `searchPOI` (the photo
    lookup a detail card triggers) took ~90 s because `ensureReady` is one
    invocation and the search is another, and a twelve-place backfill took about
    eighteen minutes. The budget is now a ceiling: the call returns as soon as the
    child exits, a late timer is a no-op, and a timer that fires first still
    aborts the child and reports `timedOut`. Two regression tests cover both
    halves (`returns as soon as the child exits…`, `leaves a finished call alone
    when its timer finally fires`).
  - **The detail window floats again.** Docking it as a column was rejected: it
    took width from the timeline. It is an absolutely placed card over the pane
    again — bottom-anchored full width when the pane is narrow, a side window at
    the bottom right once the pane is wider — still resizable from its inner edge
    with the size remembered, and the timeline keeps its full width in both
    layouts.
- 6925537: The day rail scrolls, so a two-week trip can no longer hide its last days.
  
  - **What was wrong.** The rail had no overflow of its own while its parent
    (`.trv-body`) has been `overflow: hidden` since the floating detail window
    landed. A fourteen-day trip therefore clipped at about D11 with no way to
    reach D12–D14 — the days were not just below the fold, they were unreachable.
  - The rail now owns its scrolling (`min-height: 0; overflow-y: auto`), and each
    day is one line (`D1 09-24`, 27px instead of 45px) so two weeks usually fit
    without scrolling at all. Changing day scrolls the current day back into view
    by hand rather than with `scrollIntoView`, which would also move the pane.
  - Measured on the real fourteen-day itinerary with `.verify/rail-scroll.mjs`:
    fourteen rows, `overflow-y: auto`, and after scrolling the last day is both
    visible and clickable.
- 6925537: The detail window resizes from any direction, and the clock stops losing its last
  digit to the timeline's node.
  
  - **Three handles instead of one.** The window is anchored to the bottom right, so
    its left edge and its top edge are the two free sides; each now has its own
    grip, and a corner grip drives both axes at once. Width and height are
    remembered separately, and neither is pinned until it has been dragged, so the
    window still hugs its content until you say otherwise. A bottom sheet already
    spans the pane, so there the corner can only give width back — measured with
    real pointer input: corner +82×+72, top edge +50 height with the width
    untouched, left edge +60 width with the height untouched.
  - **The node no longer eats the clock.** The 9px node carries a 3px halo and sat
    2.5px into the clock's own box, so `12:00` and `00:30` lost the right side of
    their last digit — the dot looked like it was covering the time. The clock now
    stops 7.5px short of the node instead of overlapping it, verified in the same
    browser harness.
- Repackage for the DSH 0.1.7 line: real display metadata, a compatibility
  declaration that can actually resolve, and a mount test on the current line.
  
  - **Display metadata.** The plugin card now reads a real title and artwork.
    `locale/en.json` and `locale/zh.json` carry `meta.title` / `meta.description`,
    `icon.svg` is the package icon, and `package.json` exports `./locale/*.json` and
    lists both in `files`. This matters more than it looks: DSH reads those resources
    through the Node ESM resolver **without activating the plugin**, and
    `dsh-app-boot` swallows `ERR_PACKAGE_PATH_NOT_EXPORTED`. Before this change the
    card silently showed the bare package name with default artwork, and nothing
    anywhere reported a problem.
  - **Compatibility is declared, not assumed.** `engines.dsh` and the
    `@deepseek-ai/dsh-*` peers become
    `^0.1.5-rc.2 || ^0.1.6-alpha.1 || ^0.1.7-alpha.1`, and `@deepseek-ai/cordis`
    moves to `^4.0.3`. The old single-clause ranges could never match a newer
    pre-release: semver only admits a pre-release version when a comparator with the
    same major.minor.patch also carries a pre-release tag, so `^0.1.5-rc.2` is false
    for `0.1.7-alpha.2` even though `0.1.5-rc.2` itself is true.
  - **Verified on the current line.** The packed tarball was mounted into a fresh
    isolated profile on DSH `0.1.7-alpha.2`: `dump-config` composed both rows, a
    bounded startup stayed up, and a metadata probe resolved `locale/en.json`
    through the package exports to the title `Travel Planner`. All 13 theme tokens
    used by the client were re-checked against the current theme. Details in
    `compatibility.json`.
  - **Still outstanding.** The `browser` check (a real interactive pass over the
    right-sidebar tab) was not re-run for this line and remains a human acceptance
    item.
- Picking a stop moves the map to it.
  
  - Clicking a stop in the itinerary — or a place in the library — now brings that
    place into view on the map: the map centres on it and, if it was further out
    than zoom 14, comes in close enough to see which street it is on. A zoom the
    reader already chose is kept, so the map only ever moves as far as it has to.
  - The day emphasis the scroll spy drives deliberately does not come through this
    path: scrolling the itinerary still never moves the map, and a view that is
    re-projected on every poll does not drag the map back to the selection every
    few seconds (one move per pick).
  - A place the map is not drawing — another day's stop while a single day is on
    screen — leaves the map alone, because there is no marker to travel to.
  - Verified against the real AMap surface in a browser: clicking 天安门广场 in a
    whole-trip view took its marker from 303px off the middle of a 492px map to
    15px, with the route zooming from the country fit to street level.
- 6925537: Every stop is a teardrop again, the days that are not under the cursor stay
  readable, and the markers name themselves once the view has room.
  
  - **The other days were unreadable.** The day in view was drawn at full opacity
    and the rest at 0.3, which is what made the whole-trip map look washed out the
    moment the itinerary scrolled to a day: fourteen days of pins and lines in a
    muddy grey. The rest now sit at 0.78 with the lines at 0.6, and the day in view
    keeps its emphasis through line weight (5 against 3) instead of a contrast that
    hid everything else.
  - **A teardrop for every stop.** The dot markers are gone. A day's first stop is
    its anchor and keeps `D1`…`D14`; the stops after it are the same teardrop one
    size down, carrying their place in the day. The coordinate schematic draws the
    same shapes, so the fallback and the real map read alike.
  - **Names on the markers**, above the teardrop. Thirty-two names on a
    country-wide map is a pile, not a map, so a name is drawn once the map reaches
    zoom 6 — or straight away when the view holds ten stops or fewer (the
    schematic, which has no zoom, uses the same rule at zoom 0). The name lives on
    the card's class list rather than the canvas element's: AMap owns that element
    and React rewriting its class list would drop AMap's own.
  - The schematic also reserves more headroom above the top-most pin, so a name
    chip is not clipped by the card's edge.
- 6925537: Photo lookups no longer open the AMap desktop window on their own.
  
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
- 6925537: The whole-trip map draws one continuous route, its markers are teardrops with
  order numbers, and the place strip stays out of the way.
  
  - **Continuous route.** Lines were drawn per day through that day's own stops, so
    a day with a single stop — the destination of a driving day — carried no line
    at all: on a fourteen-day trip eight of fourteen days were gaps. Each day's
    segment now runs on to the next day's first stop (`buildRouteSegments`), so the
    itinerary reads as one dashed route coloured by day, with the legend unchanged.
    The schematic fallback draws the same segments.
  - **Teardrop markers.** Numbered pills with a 起/终 label on every day's first and
    last stop became one teardrop per stop: a round head in the day's colour with a
    tail of the same colour (passed through `--trv-pin`), labelled with the stop's
    order inside its day. A two-week trip no longer shows two dozen identical
    「起」 and 「终」 markers.
  - **The place strip is a day view.** The full-map strip listing the current day's
    stops now renders for 「当天」 only; 「全程」 keeps the colour legend and drops the
    strip, which had neither meaning nor room once every day was on the map.
- 6925537: The trip switcher shows the whole workspace instead of one clipped row.
  
  - **What was wrong.** `.trv-head` is `position: relative` and only as tall as the
    header, so the switcher's `max-height: 62%` resolved against ~56px: with two
    trips in one workspace the dropdown clipped at the first row and the rest had
    to be found by scrolling a 35px-tall box. The dropdowns now anchor to the
    pane (`.trv-head` no longer establishes the containing block), so the panel is
    a slice of the pane: it hugs its content, caps at `min(74%, 520px)`, and only
    then scrolls. Measured with a 12-trip workspace: a 538px panel, nine rows fully
    visible, list scrolling, footer button still in place; with two trips both rows
    and the footer fit with no scrolling.
  - The header and footer of the panel stay put while the list scrolls, so
    「设为工作区默认行程」 never scrolls out of reach.
  - A click anywhere else now dismisses an open switcher or overflow menu (a
    transparent scrim under the panel), which a taller panel made necessary.
- Fix two tool-output defects that made the plugin's own entry points unusable on
  DSH 0.1.6-alpha line, and add the regression test that would have caught them.
  
  - **`travel_project_create` failed on every call.** The handler returned
    `activeTripId` while the tool's output schema declared only four properties
    with `additionalProperties: false`, so the runtime rejected the result:
    `"value.activeTripId" is not a declared property`. The trip *was* written and
    selected — only the model never learned its id, which invites a duplicate
    retry that then collides on the same title and start date. The field is now
    declared, and the value still reaches the caller.
  - **`travel_project_list` failed on an empty workspace.** With no selection it
    returned `activeTripId: undefined` / `selectionSource: undefined`, which the
    runtime rejects as not lossless JSON. Both fields are now spread
    conditionally, so the first call in a fresh workspace answers with
    `{count: 0, trips: [], hint}` instead of an error.
  - **The guard is a boundary, not a case list.** `tests/tool-output.spec.ts`
    drives all 13 tools through 15 happy paths (plus the revision-conflict branch)
    and asserts two things for every one of them: a schema with
    `additionalProperties: false` may not be handed an undeclared top-level key,
    and every returned value must survive `JSON.parse(JSON.stringify(...))`
    unchanged — a check that also fails on a nested `undefined`. Reverting either
    fix above turns two of its cases red.
  
  Found by exercising the tools for real while writing the bundled skill: three
  independent agents hit the create defect and two hit the list one.

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
