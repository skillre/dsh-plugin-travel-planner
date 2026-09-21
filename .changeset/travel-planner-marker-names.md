---
'@skillre/dsh-plugin-travel-planner': patch
---

Every stop is a teardrop again, the days that are not under the cursor stay
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
