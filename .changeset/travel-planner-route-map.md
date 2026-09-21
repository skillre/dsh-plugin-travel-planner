---
'@skillre/dsh-plugin-travel-planner': patch
---

The whole-trip map draws one continuous route, its markers are teardrops with
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
