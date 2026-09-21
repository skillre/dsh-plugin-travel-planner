---
'@skillre/dsh-plugin-travel-planner': minor
---

A day can be nothing but road. Transits are a first-class part of the trip, so a
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
