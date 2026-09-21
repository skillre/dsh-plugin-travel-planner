---
'@skillre/dsh-plugin-travel-planner': minor
---

The panel now lays itself out by width: a readable itinerary beside a companion
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
