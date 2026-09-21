---
'@skillre/dsh-plugin-travel-planner': minor
---

The whole-trip map gets a box it can actually fit into, and the panel stops
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
