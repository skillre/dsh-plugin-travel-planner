---
'@skillre/dsh-plugin-travel-planner': patch
---

The day rail scrolls, so a two-week trip can no longer hide its last days.

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
