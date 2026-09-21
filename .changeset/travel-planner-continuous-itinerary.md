---
'@skillre/dsh-plugin-travel-planner': minor
---

The itinerary is one continuous scroll of the whole trip instead of one day at
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
